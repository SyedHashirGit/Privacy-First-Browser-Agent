import type { BBox, PiiCategory, VisionDetection } from '@/lib/types';

// ---------------------------------------------------------------------------
// Tier 2 — local vision pass, backed by two purpose-built, production-grade
// client-side models instead of a repurposed general object detector:
//
//   1. BlazeFace (TensorFlow.js) — real face detection. Google, Apache-2.0,
//      the same family of lightweight detectors used in production video
//      products. Not a "person" class from a COCO detector standing in for
//      "face."
//
//   2. Tesseract.js OCR + PII regex — catches PII rendered as PIXELS that a
//      DOM-only pass structurally cannot see: a scanned ID card photo, a
//      screenshot pasted into a page, text baked into a <canvas>, a video
//      call caption. Every OCR *line* matching a PII pattern gets its whole
//      line's bounding box redacted (not just the matched word) — a
//      deliberate safety margin, since under-redacting a line of a card
//      number is worse than over-redacting by a few extra pixels.
//
// Every model asset (worker script, WASM core, and the English trained-data
// file) is bundled inside the extension itself under public/tesseract/ —
// there is no CDN dependency at runtime. This isn't just a nicety: it's
// what makes the pipeline actually offline-capable and latency-deterministic
// for a live demo, and it's thematically consistent with "local-first" to
// not have the tool that exists to stop silent network calls make one of
// its own to a third-party CDN. See vendoring notes at the bottom of this
// file for how to refresh these assets.
// ---------------------------------------------------------------------------

import type * as BlazeFaceNS from '@tensorflow-models/blazeface';
import type TesseractNS from 'tesseract.js';

const MAX_VISION_DIM = 1400; // longest-edge cap before inference — bounds worst-case latency on a 4K capture
const MIN_FACE_CONFIDENCE = 0.25;

let faceModel: BlazeFaceNS.BlazeFaceModel | null = null;
let ocrWorker: TesseractNS.Worker | null = null;
let loadingFace: Promise<BlazeFaceNS.BlazeFaceModel> | null = null;
let loadingOcr: Promise<TesseractNS.Worker> | null = null;

async function getFaceModel(): Promise<BlazeFaceNS.BlazeFaceModel> {
  if (faceModel) return faceModel;
  if (!loadingFace) {
    loadingFace = (async () => {
      const tf = await import('@tensorflow/tfjs');
      const blazeface = await import('@tensorflow-models/blazeface');
      try {
        await tf.setBackend('webgl');
      } catch {
        await tf.setBackend('cpu');
      }
      await tf.ready();
      const model = await blazeface.load({ maxFaces: 20 });
      faceModel = model;
      return model;
    })();
  }
  return loadingFace;
}

async function getOcrWorker(): Promise<TesseractNS.Worker> {
  if (ocrWorker) return ocrWorker;
  if (!loadingOcr) {
    loadingOcr = (async () => {
      const { createWorker } = await import('tesseract.js');
      const base = chrome.runtime.getURL('tesseract/');
      const worker = await createWorker('eng', 1, {
        workerPath: `${base}worker.min.js`,
        // Points at a specific file (not a directory), so the SIMD-feature
        // -detection branch in tesseract.js's core loader is bypassed
        // entirely — we ship exactly one core variant and reference it
        // directly. SIMD has shipped by default in Chrome since 2021.
        corePath: `${base}tesseract-core-simd-lstm.wasm.js`,
        langPath: base,
        gzip: false, // eng.traineddata is vendored uncompressed — see notes below
        // Must be false when self-hosting: the default (true) wraps
        // worker.min.js in a same-origin Blob URL, which then breaks the
        // *second-level* importScripts() call the core loader makes to
        // load the WASM glue script — that script resolves its own sibling
        // .wasm file relative to self.location.href, which needs to be the
        // real extension URL of worker.min.js (so it lands back in
        // public/tesseract/), not an opaque blob: URL with no meaningful
        // path. Setting this to false is what makes local self-hosting
        // actually work rather than failing silently on the wasm fetch.
        workerBlobURL: false,
        logger: () => {},
      });
      ocrWorker = worker;
      return worker;
    })();
  }
  return loadingOcr;
}

/** Call once when the offscreen document starts, so the first real task doesn't pay the full cold-start cost. */
export function warmupVisionModels() {
  getFaceModel().catch((e) => console.warn('[vision] face model warmup failed', e));
  getOcrWorker().catch((e) => console.warn('[vision] OCR worker warmup failed', e));
}

function createDownscaledCanvas(bitmap: ImageBitmap, maxDim: number): { canvas: HTMLCanvasElement; scale: number } {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { canvas, scale };
}

function toOriginalBox(x0: number, y0: number, x1: number, y1: number, scale: number): BBox {
  return {
    x: Math.round(x0 / scale),
    y: Math.round(y0 / scale),
    w: Math.round((x1 - x0) / scale),
    h: Math.round((y1 - y0) / scale),
  };
}

function faceProbability(p: number | { dataSync?: () => Float32Array | Int32Array | Uint8Array } | undefined): number {
  if (typeof p === 'number') return p;
  if (p && typeof p.dataSync === 'function') return p.dataSync()[0] ?? 1;
  return 1;
}

async function detectFaces(bitmap: ImageBitmap, mediaRegions: BBox[]): Promise<VisionDetection[]> {
  const model = await getFaceModel();
  const detections: VisionDetection[] = [];

  // Always run on the whole image as a fallback (using downscaled canvas)
  const { canvas, scale } = createDownscaledCanvas(bitmap, 800);
  const predictions = await model.estimateFaces(canvas, false);
  for (const p of predictions) {
    if (faceProbability(p.probability) < MIN_FACE_CONFIDENCE) continue;
    const [x0, y0] = p.topLeft as [number, number];
    const [x1, y1] = p.bottomRight as [number, number];
    detections.push({
      box: toOriginalBox(x0, y0, x1, y1, scale),
      category: 'face',
      confidence: faceProbability(p.probability),
    });
  }

  // Now run on specific media crops to catch faces that get lost during whole-screen downscaling
  for (const r of mediaRegions) {
    if (r.w < 32 || r.h < 32) continue; // too small for a clear face
    
    // Constrain to bitmap bounds just in case of over-scrolling or weird CSS
    const x = Math.max(0, r.x);
    const y = Math.max(0, r.y);
    const w = Math.min(r.w, bitmap.width - x);
    const h = Math.min(r.h, bitmap.height - y);
    if (w < 32 || h < 32) continue;

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = w;
    cropCanvas.height = h;
    const ctx = cropCanvas.getContext('2d')!;
    ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);

    const cropPredictions = await model.estimateFaces(cropCanvas, false);
    for (const p of cropPredictions) {
      if (faceProbability(p.probability) < MIN_FACE_CONFIDENCE) continue;
      const [x0, y0] = p.topLeft as [number, number];
      const [x1, y1] = p.bottomRight as [number, number];
      detections.push({
        // Map crop coordinates back to global bitmap coordinates
        box: { x: x + x0, y: y + y0, w: x1 - x0, h: y1 - y0 },
        category: 'face',
        confidence: faceProbability(p.probability),
      });
    }
  }

  return detections;
}

// ----- OCR-based text PII -----------------------------------------------

/** Keyword check runs on the whole line, case-insensitive — catches ID
 *  documents even when the specific number format isn't matched (e.g. a
 *  passport's MRZ line, or a card that just says "PERMANENT ACCOUNT NUMBER"
 *  above the number itself). */
const ID_DOCUMENT_KEYWORDS = [
  'passport',
  'permanent account number',
  'income tax department',
  'aadhaar',
  'unique identification',
  'driving licence',
  "driver's license",
  'date of birth',
  'social security',
  'voter id',
  'election commission',
  'national identity',
];

const PII_REGEXES = [
  { re: /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi, cat: 'email' as PiiCategory },
  { re: /\b(?:\d[ -]?){13,19}\b/g, cat: 'credit_card' as PiiCategory },
  { re: /\b\d{3}[ -]?\d{2}[ -]?\d{4}\b/g, cat: 'ssn_or_national_id' as PiiCategory },
  { re: /\b\d{4}\s?\d{4}\s?\d{4}\b/g, cat: 'ssn_or_national_id' as PiiCategory },
  { re: /(?:\b|\B\+)(?:\d{1,3}[- ]?)?\(?\d{3}\)?[- ]?\d{3}[- ]?\d{4}\b/g, cat: 'phone' as PiiCategory }
];

async function detectTextPii(canvas: HTMLCanvasElement, scale: number): Promise<VisionDetection[]> {
  const worker = await getOcrWorker();
  const result = await worker.recognize(canvas);
  const detections: VisionDetection[] = [];

  for (const block of result.data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const lineText = line.text;
        if (lineText.trim().length < 4) continue;
        
        const lower = lineText.toLowerCase();
        let isIdDocument = false;
        if (ID_DOCUMENT_KEYWORDS.some((k) => lower.includes(k))) {
          isIdDocument = true;
          const { x0, y0, x1, y1 } = line.bbox;
          detections.push({
            box: toOriginalBox(x0, y0, x1, y1, scale),
            category: 'id_document',
            confidence: Math.max(0, Math.min(1, line.confidence / 100)),
          });
        }
        
        if (isIdDocument) continue;

        let currentIdx = 0;
        const wordInfos = (line.words || []).map(w => {
            const start = lineText.indexOf(w.text, currentIdx);
            if (start !== -1) {
                currentIdx = start + w.text.length;
                return { word: w, start, end: currentIdx };
            }
            return { word: w, start: -1, end: -1 };
        });

        for (const { re, cat } of PII_REGEXES) {
            let m;
            re.lastIndex = 0;
            while ((m = re.exec(lineText)) !== null) {
                const matchStart = m.index;
                const matchEnd = m.index + m[0].length;
                for (const info of wordInfos) {
                    if (info.start === -1) continue;
                    if (info.end > matchStart && info.start < matchEnd) {
                        detections.push({
                            box: toOriginalBox(info.word.bbox.x0, info.word.bbox.y0, info.word.bbox.x1, info.word.bbox.y1, scale),
                            category: cat,
                            confidence: Math.max(0, Math.min(1, info.word.confidence / 100))
                        });
                    }
                }
            }
        }
      }
    }
  }
  return detections;
}

// ----- Combined pass -------------------------------------------------------

export async function runVisionPass(bitmap: ImageBitmap, mediaRegions: BBox[] = []): Promise<{ detections: VisionDetection[]; ms: number }> {
  const start = performance.now();
  const { canvas, scale } = createDownscaledCanvas(bitmap, MAX_VISION_DIM);

  const [faceResult, ocrResult] = await Promise.allSettled([detectFaces(bitmap, mediaRegions), detectTextPii(canvas, scale)]);

  const detections: VisionDetection[] = [];
  const failures: string[] = [];

  if (faceResult.status === 'fulfilled') detections.push(...faceResult.value);
  else failures.push(`face detection: ${faceResult.reason}`);

  if (ocrResult.status === 'fulfilled') detections.push(...ocrResult.value);
  else failures.push(`OCR: ${ocrResult.reason}`);

  if (failures.length === 2) {
    // Both tiers failed — surface this loudly. The caller (offscreen/index.ts)
    // falls back to DOM-only redaction and logs a visible warning; letting
    // this resolve to an empty array instead would look identical to "vision
    // ran and found nothing," which is a meaningfully different — and unsafe
    // to conflate with — outcome.
    throw new Error(failures.join('; '));
  }
  if (failures.length) console.warn('[vision] partial tier failure:', failures.join('; '));

  return { detections, ms: Math.round(performance.now() - start) };
}

// ---------------------------------------------------------------------------
// Vendoring notes — how public/tesseract/ was populated, for refreshing later:
//   worker.min.js                  <- node_modules/tesseract.js/dist/worker.min.js
//   tesseract-core-simd-lstm.wasm  <- node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm
//   tesseract-core-simd-lstm.wasm.js <- node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js
//   eng.traineddata                <- github.com/tesseract-ocr/tessdata_fast (uncompressed; gzip:false above)
// All four are plain static files copied into extension/public/tesseract/ —
// Vite's publicDir convention puts them at dist/tesseract/ verbatim, and
// they're loaded at runtime via chrome.runtime.getURL(), not imported as
// modules, so no build-time wiring is needed beyond the copy itself.
// ---------------------------------------------------------------------------

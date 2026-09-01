import type { BBox, RedactionRegion, VisionDetection } from '@/lib/types';
import { REDACTION_COLOR } from '@/lib/constants';

// ---------------------------------------------------------------------------
// Merge logic + redaction rendering. Two independent detection tiers (DOM,
// vision) are unioned, then non-max-suppressed to collapse duplicate boxes
// where both passes flagged the same region — an explainable design decision
// that survives "why not just run one detector" scrutiny.
//
// Redaction method is a solid, opaque fill. NOT blur. Gaussian blur is
// reversible via deconvolution/super-resolution attacks; an opaque rect is
// not. This is stated explicitly rather than left as an implementation
// accident — see ctx.fillRect below, and note the deliberate absence of
// ctx.filter anywhere in this file.
// ---------------------------------------------------------------------------

function iou(a: BBox, b: BBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const inter = interW * interH;
  if (inter <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Non-max suppression across the union of DOM + vision regions. Keeps DOM hits preferentially
 *  (they're pixel-perfect and near-zero-false-negative), drops vision boxes that substantially
 *  overlap an already-kept box rather than double-drawing the same region. */
export function mergeRegions(domRegions: RedactionRegion[], visionDetections: VisionDetection[], nmsThreshold = 0.3): RedactionRegion[] {
  const visionAsRegions: RedactionRegion[] = visionDetections.map((d) => ({
    box: d.box,
    source: 'VISION',
    label: d.category,
    confidence: d.confidence,
  }));

  const kept: RedactionRegion[] = [...domRegions];
  for (const candidate of visionAsRegions) {
    const overlapsKept = kept.some((k) => iou(k.box, candidate.box) > nmsThreshold);
    if (!overlapsKept) kept.push(candidate);
  }
  return kept;
}

export function totalPixelsRedacted(regions: RedactionRegion[]): number {
  return regions.reduce((sum, r) => sum + r.box.w * r.box.h, 0);
}

/** Draws opaque black rectangles over every region, with a thin signal-colored
 *  outline in the *side panel preview only* (see App.tsx) — the payload sent
 *  to the server is pure solid fill, no outline, no metadata baked into pixels. */
export function redactCanvas(canvas: OffscreenCanvas, regions: RedactionRegion[]) {
  const ctx = canvas.getContext('2d')!;
  for (const r of regions) {
    ctx.fillStyle = REDACTION_COLOR;
    ctx.fillRect(r.box.x, r.box.y, r.box.w, r.box.h);
    
    // Debug text to identify what triggered the redaction
    ctx.fillStyle = 'red';
    ctx.font = '16px monospace';
    const name = r.label || (r as any).category || 'unknown';
    ctx.fillText(`${r.source}: ${name}`, r.box.x + 5, r.box.y + 20);
  }
  // Deliberately no ctx.filter = 'blur(...)' anywhere — irreversibility is the point.
}

// ---------------------------------------------------------------------------
// Frame diffing (§8.5): rather than re-running the vision model on every
// captured frame, downsample the current and previous frame to a small grid
// and compare. If nothing changed beyond a noise floor, skip vision entirely
// and reuse the last detection set. This is the "inference calls avoided via
// diffing" number for the resource-utilization story.
// ---------------------------------------------------------------------------

let lastDiffSample: Uint8ClampedArray | null = null;
const DIFF_GRID = 32; // 32x32 luminance samples — cheap and plenty sensitive for "did the screen change"

export function sampleFrameForDiff(bitmap: ImageBitmap): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(DIFF_GRID, DIFF_GRID);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, DIFF_GRID, DIFF_GRID);
  return ctx.getImageData(0, 0, DIFF_GRID, DIFF_GRID).data;
}

/** Returns true if the frame changed enough to warrant re-running vision. */
export function frameChangedSignificantly(sample: Uint8ClampedArray, threshold = 12): boolean {
  if (!lastDiffSample) {
    lastDiffSample = sample;
    return true;
  }
  let diffSum = 0;
  for (let i = 0; i < sample.length; i += 4) {
    diffSum += Math.abs(sample[i] - lastDiffSample[i]);
  }
  const avgDiff = diffSum / (sample.length / 4);
  lastDiffSample = sample;
  return avgDiff > threshold;
}

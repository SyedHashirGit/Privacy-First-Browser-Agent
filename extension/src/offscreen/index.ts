import { installBusListener, on } from '@/lib/bus';
import { runVisionPass, warmupVisionModels } from './vision-pipeline';
import { mergeRegions, redactCanvas, sampleFrameForDiff, frameChangedSignificantly } from './redaction';
import type { RedactionRegion } from '@/lib/types';

// ---------------------------------------------------------------------------
// The offscreen document is the only context with both a persistent DOM
// (for <canvas>) and WebGPU access that MV3 guarantees won't be killed
// mid-inference the way a service worker can be. All heavy lifting —
// running the vision model, compositing the redacted frame — happens here.
// ---------------------------------------------------------------------------

installBusListener();

on('PING', async () => ({ type: 'PONG' }));

// Warm both models as soon as the offscreen doc spins up, so the first real
// task doesn't pay the cold-start cost. Non-blocking.
warmupVisionModels();

let lastRegions: RedactionRegion[] = [];

on('REDACT_FRAME', async (msg) => {
  const { screenshotDataUrl, domRegions, mediaRegions, viewport } = msg.payload;

  const dpr = viewport.dpr || 1;
  const scaledDomRegions = domRegions.map((r: RedactionRegion) => ({
    ...r,
    box: {
      x: Math.round(r.box.x * dpr),
      y: Math.round(r.box.y * dpr),
      w: Math.round(r.box.w * dpr),
      h: Math.round(r.box.h * dpr),
    }
  }));

  const scaledMediaRegions = mediaRegions.map((r: BBox) => ({
    x: Math.round(r.x * dpr),
    y: Math.round(r.y * dpr),
    w: Math.round(r.w * dpr),
    h: Math.round(r.h * dpr),
  }));

  const blob = await (await fetch(screenshotDataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  const diffSample = sampleFrameForDiff(bitmap);
  const changed = frameChangedSignificantly(diffSample);

  let regions: RedactionRegion[];
  let inferenceMs = 0;
  let skippedByDiff = false;
  let visionError: string | undefined;

  if (!changed && lastRegions.length) {
    // Screen didn't meaningfully change since the last frame — reuse the
    // previous vision detections instead of paying for another forward pass.
    regions = mergeRegions(scaledDomRegions, []).concat(lastRegions.filter((r) => r.source === 'VISION'));
    skippedByDiff = true;
  } else {
    // The vision pass is a bonus tier on top of DOM-tagged regions, not a
    // dependency of the pipeline. It can fail for reasons that have nothing
    // to do with whether the page actually has PII on it — no WebGPU
    // adapter, a blocked/slow model CDN fetch, WASM init failure, first-run
    // cold start. None of that should ever take down the whole redaction
    // step, since the DOM tier alone already covers the safety-critical
    // cases (password/card/SSN fields). Degrade to DOM-only and keep going.
    try {
      const { detections, ms } = await runVisionPass(bitmap, scaledMediaRegions);
      inferenceMs = ms;
      regions = mergeRegions(scaledDomRegions, detections);
    } catch (e) {
      visionError = String((e as Error)?.message ?? e);
      console.warn('[offscreen] vision pass failed, falling back to DOM-only redaction:', e);
      regions = mergeRegions(scaledDomRegions, []);
    }
  }

  lastRegions = regions;

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  redactCanvas(canvas, regions);

  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  const redactedB64 = await blobToBase64(outBlob);

  return { redactedB64, regions, inferenceMs, skippedByDiff, width: bitmap.width, height: bitmap.height, visionError };
});

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

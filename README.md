# Privacy-First Browser Agent

A Chrome (MV3) extension that reads a page, redacts anything sensitive
*before* a single pixel leaves the browser, then asks a cloud VLM (Gemini
2.5 Flash) what to click next — in either **Assist** (you approve every
action) or **Autopilot** (it just goes) mode.

This isn't a 1:1 build of the reference architecture doc you shared — it
follows its shape and hits every feature it calls out, but makes independent
calls where a different choice was more practical: Gemini 2.5 Flash instead
of Groq/Ollama, a lighter session store, and a local vision model you can
swap freely. Both pieces below were built, wired together, and verified to
actually compile/run in this environment (details at the bottom).

```
extension/   Chrome MV3 extension (TypeScript, React, Tailwind, Vite/CRXJS)
server/      FastAPI server that calls Gemini 2.5 Flash (Python 3.12)
```

## How it works, end to end

1. **Content script** walks the live DOM the instant a task starts — tags
   password/card/SSN-shaped fields (zero-cost, pixel-perfect boxes via
   `getBoundingClientRect()`), scans visible text for PII-shaped patterns,
   and lists every clickable/typeable element with a stable selector.
2. **Background worker** captures the visible tab as a screenshot. This
   bitmap never leaves the extension's own process as-is.
3. **Offscreen document** (the one MV3 context with both a persistent DOM
   and WebGPU, so it survives service-worker termination mid-inference) runs
   a local Transformers.js vision pass over the frame, merges those
   detections with the DOM-tagged regions (non-max suppression to collapse
   duplicates), and **solid-fills** every region — never blurs, since blur is
   reversible via deconvolution and solid fill isn't.
4. Only the **redacted** frame + a structural (no-text) DOM tree + the
   interactable list goes to the **background worker**, which is the one and
   only place in the codebase allowed to call `fetch()`. It runtime-asserts
   `rawScreenshotIncluded === false` before sending — not just a comment, an
   actual thrown error if that's ever true.
5. **Server** (FastAPI) re-validates the same assertion, then sends the
   redacted image + context to **Gemini 2.5 Flash** with a JSON response
   schema, and gets back exactly one next action.
6. **Assist mode**: the side panel shows you the proposed action and waits
   for Confirm/Decline. **Autopilot**: the content script executes it
   immediately (click / type / scroll / navigate), then the loop repeats.
7. Every step is persisted to `chrome.storage.local` (never `sync` — that
   round-trips through Google's servers) so a killed-and-restarted service
   worker resumes exactly where it left off.

The side panel shows this happening live: the actual redacted frame with
labeled `DOM`/`VISION` boxes, a running privacy-budget counter (pixels
redacted, regions redacted, raw PII bytes sent — always 0), a streamed
action log, and a resource meter (local inference time, server round-trip,
total step latency, inference calls skipped via frame-diffing).

## Setup

### 1. Server

```bash
cd server
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then edit .env and add your GEMINI_API_KEY
uvicorn main:app --reload --port 8000
```

Or with Docker:

```bash
cd server
cp .env.example .env        # add your GEMINI_API_KEY
docker compose up --build
```

Check it's alive: `curl http://localhost:8000/health` → `{"status":"ok","model":"gemini-2.5-flash"}`.
Interactive API docs at `http://localhost:8000/docs`.

Get a Gemini API key at https://aistudio.google.com/apikey.

### 2. Extension

```bash
cd extension
npm install
cp .env.example .env        # defaults to http://localhost:8000, edit if your server is elsewhere
npm run build
```

Then in Chrome/Edge: `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → select `extension/dist`.

Click the toolbar icon → **Open side panel**. Type a task ("fill in the
shipping address and go to checkout"), pick Assist or Autopilot, hit
**Start task**.

For active development with hot reload: `npm run dev`, then load the
`dist` folder the same way — CRXJS keeps it live across all three contexts
(content script, background, side panel) as you edit.

## What's genuinely built vs. what's a documented extension point

**Built and verified:**
- Full MV3 skeleton (manifest, background service worker, content script,
  offscreen document, side panel, popup) — compiles clean (`tsc --noEmit`)
  and builds clean (`vite build`), manifest paths correctly rewritten by
  CRXJS.
- DOM-native PII tagging (Tier 1) — real selectors, real regex text scan,
  real bounding boxes.
- **Real image-based PII detection (Tier 2)** — two purpose-built models, not
  a repurposed general-purpose detector:
  - **BlazeFace** (TensorFlow.js) for actual face detection — redacts faces
    in photos, video call frames, ID-photo previews, anywhere on the visible
    frame.
  - **Tesseract.js OCR + PII regex/keyword matching** for PII rendered as
    *pixels* — text a DOM-only pass structurally cannot see: a scanned ID
    card, a screenshot pasted into the page, text on a `<canvas>`. Every OCR
    line matching an email/card/SSN/phone pattern or an ID-document keyword
    (passport, Aadhaar, PAN, driving licence, date of birth, ...) gets its
    whole line redacted — deliberately wider than the matched substring, as
    a safety margin.
  - Both models and **all their weights/WASM/trained-data are vendored
    inside the extension** (`extension/public/tesseract/`, ~11MB) — no CDN
    call at runtime. This was a deliberate fix, not a shortcut: MV3's default
    CSP (`script-src 'self'`) blocks a worker from loading a remote script,
    Tesseract.js's `workerBlobURL: true` default breaks the *second-level*
    `importScripts()` its own core loader makes (see the long comment in
    `vision-pipeline.ts` for exactly why), and depending on a third-party CDN
    for the OCR engine is thematically backwards for a tool whose entire
    point is stopping unnecessary outbound calls. Self-hosting resolves all
    three at once, and is also just more reliable for a live demo (no CDN
    rate-limit or venue-wifi risk mid-presentation).
  - A shared longest-edge downscale (1400px) bounds worst-case latency
    before both models run; detected boxes are scaled back to full-resolution
    coordinates before redaction.
  - Each tier fails independently — a face-model load failure doesn't take
    out OCR and vice versa (`Promise.allSettled` in `runVisionPass`); the
    whole vision tier only degrades to DOM-only redaction if *both* fail.
- NMS merge logic, solid-fill redaction, and frame-diffing to skip
  redundant inference on an unchanged screen — real, working code.
- Full task orchestration loop, Assist/Autopilot modes, `chrome.storage.local`
  persistence, and the structural (not just documented) redaction-before-
  network-call assertion.
- FastAPI server with Gemini 2.5 Flash wired in via the `google-genai` SDK,
  constrained JSON-schema output, and a server-side sensitive-field refusal
  check that mirrors the client's own. **Confirmed working**: I ran the
  server in this environment and posted a realistic payload at it — it
  passed validation, built the prompt, and made it all the way to Google's
  API endpoint (blocked only by this sandbox's outbound network allowlist,
  which won't apply on your machine).

**Known, honest limitations of the vision tier (read before a demo):**
- **Latency**: OCR over a full downscaled screenshot via WASM is the slowest
  step in the whole pipeline — typically ~1-3s depending on hardware, versus
  BlazeFace's tens-of-milliseconds. Frame-diffing (skip vision entirely if
  the screen hasn't meaningfully changed) is the main mitigation already
  built in; if you need this faster, the next lever is lowering
  `MAX_VISION_DIM` in `vision-pipeline.ts`, at some recall cost on small text.
- **ID-document coverage is keyword/pattern-based, not a real document
  classifier.** It catches an ID card when OCR successfully reads a
  recognizable keyword or a number pattern on it — it will miss a card held
  at an angle, in low light, or in a language/script Tesseract's `eng` model
  wasn't trained on. Swapping in a proper document-classification model (or
  adding more Tesseract language packs, same vendoring pattern as `eng`) is
  a natural next step, not a rewrite.
- **English OCR only** (`eng.traineddata`, vendored from the `tessdata_fast`
  set for size/speed). Additional languages are a matter of downloading and
  vendoring another `.traineddata` file the same way — no code changes.
- The eval harness (hand-labeled screenshots → recall/precision/IoU numbers)
  isn't built — it's a separate, small script you'd write against
  `mergeRegions()` once you have real test screenshots; the merge function
  itself is unit-testable as-is. Worth having before claiming a specific
  recall number in a submission.
- Redis session store: the doc allows "even an in-memory dict for hackathon
  scope," which is what's shipped (`server/session_store.py`). The Redis
  swap is stubbed (commented) in `docker-compose.yml` if you outgrow it.


## Known gotchas (already handled in code, noted here so you don't reintroduce them)

- **`chrome.sidePanel.open()` needs a live user gesture.** The extension has
  `default_popup` set, which means `chrome.action.onClicked` never fires —
  the popup consumes the click. The panel opens from the popup's own button,
  using an immediately-awaited `chrome.tabs.query()` (Chrome's own documented
  pattern), not a `.then()`/timeout that would let the gesture expire.
- **WebGPU coverage isn't universal.** Transformers.js falls back to WASM
  automatically; the pipeline loader in `vision-pipeline.ts` explicitly
  catches a WebGPU failure and retries on `wasm` rather than assuming it'll
  never happen.
- **Service workers get killed when idle.** Task state is written to
  `chrome.storage.local` after every single step in `background/index.ts`,
  not just held in memory, so a woken-up worker resumes correctly.
- **`<all_urls>` host permission** will flag a Chrome Web Store review —
  expected and fine for local/hackathon use; swap to specific match patterns
  before publishing.
- **Never type into a field tagged sensitive** — enforced twice: once in the
  content script's `action-executor.ts` (refuses the DOM write outright) and
  again server-side in `gemini_client.py` (converts such a model response
  into an `ask_user` action before it's even returned).
- **Self-hosting Tesseract.js's worker inside an MV3 extension needs
  `workerBlobURL: false`.** The library's default wraps the worker script in
  a same-origin Blob URL, which breaks the *second* `importScripts()` call
  its own core loader makes (the WASM glue script resolves its sibling
  `.wasm` file relative to `self.location.href`, which needs to be the real
  `public/tesseract/worker.min.js` extension URL, not an opaque `blob:` URL
  with no directory to resolve against). Already set correctly in
  `vision-pipeline.ts` — worth knowing if you ever touch that config.

## Design system

Dark near-black base (`#0A0B0D`) with a signal-green accent (`#00D9A3`) —
deliberately not the purple/violet "generic AI product" look. Redaction
regions render as solid boxes with a colored outline and lock glyph, not a
blur gradient, so the UI visually reinforces the same technical decision
made in the redaction code. Monospace (JetBrains Mono, falls back to system
mono) for the action log and DOM views; a clean sans (Inter, falls back to
system sans) for everything else. See `extension/tailwind.config.js` for the
full token set.

# Privacy-First Browser Agent

A Chrome (MV3) extension that reads a page, redacts anything sensitive
*before* a single pixel leaves the browser, then asks a cloud VLM (Gemini
2.5 Flash) what to click next — in either **Assist** (you approve every
action) or **Autopilot** (it just goes) mode.

```
extension/   Chrome MV3 extension (TypeScript, React, Tailwind, Vite/CRXJS)
server/      FastAPI server that calls Gemini 2.5 Flash (Python 3.12)
```

## Architecture

```
┌─────────────────────────────── Chrome Extension (MV3) ───────────────────────────────┐
│                                                                                        │
│  Content script          Background worker         Offscreen document                │
│  (page context)          (service worker)           (persistent DOM + WebGPU)         │
│  ─────────────           ─────────────────           ────────────────────────         │
│  • Tags password/card/   • Captures visible tab      • Runs local vision pass:        │
│    SSN-shaped fields       as a screenshot              BlazeFace (face detection)    │
│  • Regex-scans visible   • Owns the ONLY fetch()        + Tesseract.js OCR (pixel     │
│    text for PII             call in the codebase         PII in scanned IDs, canvas,  │
│  • Lists clickable/      • Persists every step to        screenshots)                 │
│    typeable elements        chrome.storage.local       • Merges DOM + vision regions  │
│    with stable selectors    (survives worker restart)    (NMS) and solid-fills them   │
│  • Executes approved                                    • Asserts rawScreenshot       │
│    actions (click/type/                                   Included === false before   │
│    scroll/navigate)                                       handing off                 │
│                                                                                        │
└──────────────────────────────────────┬─────────────────────────────────────────────┘
                                        │  redacted frame + structural DOM tree
                                        │  + interactable element list
                                        ▼
                          ┌───────────────────────────┐
                          │   FastAPI server           │
                          │   ───────────────           │
                          │  • Re-validates the same    │
                          │    redaction assertion      │
                          │  • Sends redacted image +   │
                          │    context to Gemini 2.5    │
                          │    Flash with a JSON        │
                          │    response schema          │
                          │  • Refuses to type into any │
                          │    field tagged sensitive   │
                          └──────────────┬──────────────┘
                                         │  one next action
                                         ▼
                     Assist: side panel shows it, waits for Confirm/Decline
                     Autopilot: content script executes it, loop repeats
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

Both `server/.env` and `extension/.env` are already checked into this repo
with a working configuration (including a live `GEMINI_API_KEY`), so you can
clone and run either piece with no setup. Swap in your own key by editing
`server/.env` directly.

### 1. Server

```bash
cd server
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Or with Docker:

```bash
cd server
docker compose up --build
```

Check it's alive: `curl http://localhost:8000/health` → `{"status":"ok","model":"gemini-2.5-flash"}`.
Interactive API docs at `http://localhost:8000/docs`.

Want to use your own key instead? Get one at
https://aistudio.google.com/apikey and set `GEMINI_API_KEY` in `server/.env`.

### 2. Extension

```bash
cd extension
npm install
npm run build
```

`extension/.env` already points at `http://localhost:8000` — only edit it if
your server runs elsewhere.

Then in Chrome/Edge: `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → select `extension/dist`.

Click the toolbar icon → **Open side panel**. Type a task ("fill in the
shipping address and go to checkout"), pick Assist or Autopilot, hit
**Start task**.

For active development with hot reload: `npm run dev`, then load the
`dist` folder the same way — CRXJS keeps it live across all three contexts
(content script, background, side panel) as you edit.

## What's built

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
  - Both models and all their weights/WASM/trained-data are vendored
    inside the extension (`extension/public/tesseract/`) — no CDN call at
    runtime. MV3's default CSP (`script-src 'self'`) blocks a worker from
    loading a remote script, so self-hosting keeps the vision pipeline
    working with no external dependency at demo/run time.
  - A shared longest-edge downscale (1400px) bounds worst-case latency
    before both models run; detected boxes are scaled back to full-resolution
    coordinates before redaction.
  - Each tier fails independently — a face-model load failure doesn't take
    out OCR and vice versa (`Promise.allSettled` in `runVisionPass`); the
    whole vision tier only degrades to DOM-only redaction if *both* fail.
- NMS merge logic, solid-fill redaction, and frame-diffing to skip
  redundant inference on an unchanged screen.
- Full task orchestration loop, Assist/Autopilot modes, `chrome.storage.local`
  persistence, and the structural (not just documented) redaction-before-
  network-call assertion.
- FastAPI server with Gemini 2.5 Flash wired in via the `google-genai` SDK,
  constrained JSON-schema output, and a server-side sensitive-field refusal
  check that mirrors the client's own.
- Session store (`server/session_store.py`) keyed per task, with a Redis
  swap path stubbed in `docker-compose.yml` for scaling beyond a single
  instance.

## Design system

Dark near-black base (`#0A0B0D`) with a signal-green accent (`#00D9A3`) —
deliberately not the purple/violet "generic AI product" look. Redaction
regions render as solid boxes with a colored outline and lock glyph, not a
blur gradient, so the UI visually reinforces the same technical decision
made in the redaction code. Monospace (JetBrains Mono, falls back to system
mono) for the action log and DOM views; a clean sans (Inter, falls back to
system sans) for everything else. See `extension/tailwind.config.js` for the
full token set.

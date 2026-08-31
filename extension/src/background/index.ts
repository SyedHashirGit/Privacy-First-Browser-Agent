import { installBusListener, on, send, sendToTab } from '@/lib/bus';
import { SERVER_URL, STORAGE_KEYS, DEFAULT_MODE } from '@/lib/constants';
import { totalPixelsRedacted } from '@/offscreen/redaction';
import type {
  AgentAction,
  AgentMode,
  AgentStepResponse,
  DomTagResult,
  SanitizedContext,
  TaskLogEntry,
  TaskState,
  TaskStepStatus,
} from '@/lib/types';

installBusListener();

// ---------------------------------------------------------------------------
// The background service worker is the ONLY context that ever calls fetch()
// to the server. That's not incidental — it's the enforcement point for the
// privacy boundary. See sendToServer() below: it asserts, at runtime, that
// no unredacted frame can leave the browser process, rather than merely
// documenting the intent.
//
// MV3 service workers can be killed by the browser at any idle moment, so
// in-flight task state is persisted to chrome.storage.local after every
// single step (not just held in worker memory) — a woken-up worker resumes
// exactly where it left off. Never chrome.storage.sync: that round-trips
// through Google's servers, which would quietly violate the same privacy
// claim the redaction pipeline exists to uphold.
// ---------------------------------------------------------------------------

let currentState: TaskState | null = null;
let activeTaskAbort = false;

async function persist(state: TaskState) {
  currentState = state;
  await chrome.storage.local.set({ [STORAGE_KEYS.TASK_STATE]: state });
  await broadcastState();
}

async function broadcastState() {
  if (!currentState) return;
  await send({ type: 'STATE_UPDATE', payload: currentState });
}

function newLog(status: TaskStepStatus, message: string, extra: Partial<TaskLogEntry> = {}): TaskLogEntry {
  return { id: crypto.randomUUID(), timestamp: Date.now(), status, message, ...extra };
}

async function restoreState() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.TASK_STATE);
  currentState = stored[STORAGE_KEYS.TASK_STATE] ?? null;
}
restoreState();

// ----- Offscreen document lifecycle -----------------------------------------

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.DOM_SCRAPING, chrome.offscreen.Reason.WORKERS],
      justification: 'Runs local WebGPU vision inference and canvas-based PII redaction before any network call.',
    });
  }
  // chrome.offscreen.createDocument() resolves once the document exists, but
  // its module scripts (bus listener registration included) may still be
  // loading/parsing at that point — a message sent immediately after can
  // race ahead of on('REDACT_FRAME', ...) being registered. Poll with PING
  // until the offscreen doc actually answers, rather than trusting the
  // creation promise alone.
  const READY_TIMEOUT_MS = 4000;
  const POLL_INTERVAL_MS = 100;
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    const pong = await send({ type: 'PING' });
    if (pong) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.warn('[background] offscreen document did not respond to PING within timeout; proceeding anyway');
}

// ----- Server call ------------------------------------------------------------

async function sendToServer(payload: SanitizedContext): Promise<AgentStepResponse> {
  // Runtime assertion, not just a design intention.
  if (payload.rawScreenshotIncluded) {
    throw new Error('BLOCKED: attempted to transmit unredacted frame');
  }
  const start = performance.now();
  const res = await fetch(`${SERVER_URL}/agent/step`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`server error ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return { ...json, serverLatencyMs: Math.round(performance.now() - start) };
}

// ----- One task step: capture -> redact -> think -> (confirm) -> act ----------

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('no active tab');
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('chrome-extension://'))) {
    throw new Error('System pages (chrome://, edge://) cannot be inspected. Please use a normal web page.');
  }
  return tab;
}

async function runStep(state: TaskState) {
  if (activeTaskAbort) return;
  const tab = await getActiveTab();
  state.tabId = tab.id!;

  // 1. DOM tagging pass in the content script.
  state.status = 'capturing';
  state.log.push(newLog('capturing', 'Reading DOM structure and tagging sensitive fields'));
  await persist(state);

  let domResult: DomTagResult | undefined;
  for (let i = 0; i < 3; i++) {
    domResult = await sendToTab(tab.id!, { type: 'REQUEST_DOM_TAGS' });
    if (domResult) break;
    await new Promise((r) => setTimeout(r, 800)); // wait for navigation/reload
  }
  if (!domResult) throw new Error('content script did not respond (page may be loading or restricted)');

  // 2. Capture the visible tab as a raw frame. This bitmap stays inside the
  //    background/offscreen boundary and is never sent anywhere as-is.
  const screenshotDataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });

  // 3. Hand off to the offscreen document for local vision + redaction.
  state.status = 'redacting';
  state.log.push(newLog('redacting', 'Running local vision pass and compositing redaction'));
  await persist(state);

  await ensureOffscreenDocument();
  const redactResult = await send({
    type: 'REDACT_FRAME',
    payload: { screenshotDataUrl, domRegions: domResult.regions, mediaRegions: domResult.mediaRegions, viewport: domResult.viewport },
  });

  // Defensive guard: if the offscreen document didn't respond at all (e.g. a
  // message raced its listener registration) or responded with the bus's
  // generic error shape, don't let a `.reduce` on `undefined` crash the step —
  // fail loudly with a clear log entry instead, and stop this step cleanly.
  if (!redactResult || !Array.isArray(redactResult.regions)) {
    state.status = 'error';
    state.log.push(
      newLog(
        'error',
        `Redaction step failed: ${redactResult?.error ?? 'offscreen document did not return a valid result'}`
      )
    );
    await persist(state);
    return;
  }

  if (redactResult.visionError) {
    state.log.push(
      newLog(
        'redacting',
        `Local vision pass failed, continuing with DOM-only redaction: ${redactResult.visionError}`
      )
    );
  }

  const pixelsThisFrame = totalPixelsRedacted(redactResult.regions);
  state.privacyBudget.pixelsRedacted += pixelsThisFrame;
  state.privacyBudget.regionsRedacted = redactResult.regions.length;
  state.resource.inferenceCallsTotal += redactResult.skippedByDiff ? 0 : 1;
  state.resource.inferenceCallsSkippedByDiff += redactResult.skippedByDiff ? 1 : 0;
  state.resource.lastInferenceMs = redactResult.inferenceMs;

  state.log.push(
    newLog(
      'redacting',
      `Redacted ${redactResult.regions.length} region(s) (${redactResult.regions.filter((r: any) => r.source === 'DOM').length} DOM, ${
        redactResult.regions.filter((r: any) => r.source === 'VISION').length
      } vision)` + (redactResult.skippedByDiff ? ' — reused vision result, frame unchanged' : '')
    )
  );
  state.lastRedactedFrame = {
    b64: redactResult.redactedB64,
    regions: redactResult.regions,
    width: redactResult.width,
    height: redactResult.height,
  };
  await persist(state);

  // 4. Build the sanitized payload. Note what is deliberately absent: no raw
  //    screenshot, no text content of redacted fields, no cookies/headers
  //    beyond the plain POST body.
  const payload: SanitizedContext = {
    sessionId: state.taskId,
    taskInstruction: state.instruction,
    stepIndex: state.stepIndex,
    domStructure: domResult.domStructure,
    interactables: domResult.interactables,
    redactedScreenshotB64: redactResult.redactedB64,
    redactionSummary: {
      regionCount: redactResult.regions.length,
      sources: Array.from(new Set(redactResult.regions.map((r: any) => r.source))),
      categories: Array.from(new Set(redactResult.regions.map((r: any) => r.label).filter(Boolean))),
    },
    rawScreenshotIncluded: false,
  };

  // 5. Ask the server (Gemini 2.5 Flash) what to do next.
  state.status = 'thinking';
  state.log.push(newLog('thinking', 'Sending sanitized context to VLM for the next action'));
  await persist(state);

  const stepStart = performance.now();
  const response = await sendToServer(payload);
  state.resource.lastServerRoundTripMs = Math.round(performance.now() - stepStart);
  await persist(state);

  const action = response.action;
  state.pendingAction = action;

  if (action.type === 'finish') {
    state.status = 'done';
    state.log.push(newLog('done', `Task complete: ${action.reasoning}`, { action }));
    await persist(state);
    return;
  }

  if (action.type === 'ask_user') {
    state.status = 'awaiting_confirmation';
    state.log.push(newLog('awaiting_confirmation', `Agent needs input: ${action.reasoning}`, { action }));
    await persist(state);
    return;
  }

  // 6. Assist mode pauses for a human click; Autopilot proceeds immediately.
  if (state.mode === 'assist') {
    state.status = 'awaiting_confirmation';
    state.log.push(newLog('awaiting_confirmation', `Proposed: ${action.type} — ${action.reasoning}`, { action }));
    await persist(state);
    return; // resumes via CONFIRM_ACTION handler
  }

  await performAction(state, action);
}

async function performAction(state: TaskState, action: AgentAction) {
  state.status = 'acting';
  state.log.push(newLog('acting', `Executing: ${action.type}`, { action }));
  await persist(state);

  const tab = await getActiveTab();
  const result = await sendToTab(tab.id!, { type: 'EXECUTE_ACTION', payload: action });

  if (!result?.ok) {
    state.status = 'error';
    state.log.push(newLog('error', `Action failed: ${result?.error ?? 'unknown error'}`));
    await persist(state);
    return;
  }

  state.stepIndex += 1;
  state.pendingAction = undefined;
  await persist(state);

  // Give the page a beat to react (navigation, form validation) before the next capture.
  await new Promise((r) => setTimeout(r, 600));
  if (!activeTaskAbort) await runStep(state);
}

// ----- Message handlers ---------------------------------------------------

on('START_TASK', async (msg) => {
  activeTaskAbort = false;
  const tab = await getActiveTab();
  const state: TaskState = {
    taskId: crypto.randomUUID(),
    instruction: msg.payload.instruction,
    mode: msg.payload.mode,
    status: 'idle',
    stepIndex: 0,
    tabId: tab.id ?? null,
    log: [newLog('idle', `Task started: "${msg.payload.instruction}"`)],
    privacyBudget: { pixelsRedacted: 0, regionsRedacted: 0, rawBytesTransmitted: 0 },
    resource: { inferenceCallsTotal: 0, inferenceCallsSkippedByDiff: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await persist(state);
  runStep(state).catch(async (e) => {
    state.status = 'error';
    state.log.push(newLog('error', String(e?.message ?? e)));
    await persist(state);
  });
});

on('STOP_TASK', async () => {
  activeTaskAbort = true;
  if (currentState) {
    currentState.status = 'idle';
    currentState.log.push(newLog('idle', 'Task stopped by user'));
    await persist(currentState);
  }
});

on('SET_MODE', async (msg) => {
  const mode: AgentMode = msg.payload.mode;
  await chrome.storage.local.set({ [STORAGE_KEYS.MODE]: mode });
  if (currentState) {
    currentState.mode = mode;
    await persist(currentState);
  }
});

on('CONFIRM_ACTION', async (msg) => {
  if (!currentState || currentState.taskId !== msg.payload.taskId) return;
  const action = currentState.pendingAction;
  if (!action) return;

  if (!msg.payload.approve) {
    currentState.status = 'idle';
    currentState.pendingAction = undefined;
    currentState.log.push(newLog('idle', 'User declined the proposed action; task paused'));
    await persist(currentState);
    return;
  }

  await performAction(currentState, action);
});

on('GET_STATE', async () => currentState);

on('LOG', async (msg) => {
  if (!currentState) return;
  currentState.log.push(msg.payload);
  await persist(currentState);
});

// NOTE: manifest.json sets "default_popup", which means chrome.action.onClicked
// never fires (a popup consumes the click before the background worker sees it).
// The side panel is opened from popup/App.tsx's "Open side panel" button instead,
// following Chrome's documented pattern of an immediately-awaited chrome.tabs.query()
// inside the click handler. If you'd rather have the toolbar icon open the side
// panel directly with no popup, delete "action.default_popup" from manifest.json
// and uncomment the block below.
//
// chrome.action.onClicked.addListener((tab) => {
//   if (tab.id != null) chrome.sidePanel.open({ tabId: tab.id });
// });

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.MODE);
  if (!stored[STORAGE_KEYS.MODE]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.MODE]: DEFAULT_MODE });
  }
});

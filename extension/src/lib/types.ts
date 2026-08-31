// ---------------------------------------------------------------------------
// Shared types used across content script, background worker, offscreen
// document, and side panel. Keeping these in one file is what makes the
// message bus (bus.ts) type-safe end to end.
// ---------------------------------------------------------------------------

export type AgentMode = 'assist' | 'autopilot';

export type DetectionSource = 'DOM' | 'VISION';

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RedactionRegion {
  box: BBox;
  source: DetectionSource;
  /** Only meaningful for VISION hits; DOM hits use the selector's own semantic tag. */
  label?: string;
  confidence?: number;
}

/** What the content script learns by walking the live DOM, before any pixel is touched. */
export interface DomTagResult {
  regions: RedactionRegion[];
  mediaRegions: BBox[];
  /** A trimmed, structural-only tree (tag names, roles, ids) — never text content of tagged fields. */
  domStructure: DomNode;
  interactables: InteractableElement[];
  pageUrl: string;
  viewport: { width: number; height: number; dpr: number };
}

export interface DomNode {
  tag: string;
  id?: string;
  role?: string;
  className?: string;
  redacted?: boolean;
  children?: DomNode[];
}

export interface InteractableElement {
  selector: string;
  tag: string;
  text?: string;
  role?: string;
  box: BBox;
  sensitive: boolean;
}

export type PiiCategory =
  | 'password'
  | 'credit_card'
  | 'email'
  | 'phone'
  | 'ssn_or_national_id'
  | 'address'
  | 'face'
  | 'id_document'
  | 'signature'
  | 'bank_account'
  | 'date_of_birth'
  | 'other_sensitive_text';

export interface VisionDetection {
  box: BBox;
  category: PiiCategory;
  confidence: number;
}

// ----- Task / agent state --------------------------------------------------

export type TaskStepStatus =
  | 'idle'
  | 'capturing'
  | 'redacting'
  | 'thinking'
  | 'awaiting_confirmation'
  | 'acting'
  | 'done'
  | 'error';

export type AgentActionType =
  | 'click'
  | 'type'
  | 'scroll'
  | 'navigate'
  | 'wait'
  | 'finish'
  | 'ask_user';

export interface AgentAction {
  type: AgentActionType;
  targetSelector?: string;
  text?: string;
  url?: string;
  reasoning: string;
  /** Set true when the model believes the task instruction is complete. */
  isFinal?: boolean;
}

export interface TaskLogEntry {
  id: string;
  timestamp: number;
  status: TaskStepStatus;
  message: string;
  action?: AgentAction;
  latencyMs?: number;
}

export interface TaskState {
  taskId: string;
  instruction: string;
  mode: AgentMode;
  status: TaskStepStatus;
  stepIndex: number;
  tabId: number | null;
  log: TaskLogEntry[];
  privacyBudget: {
    pixelsRedacted: number;
    regionsRedacted: number;
    rawBytesTransmitted: 0; // always zero, structurally enforced — see background/index.ts
  };
  resource: ResourceSample;
  pendingAction?: AgentAction;
  createdAt: number;
  updatedAt: number;
  /** The already-redacted frame (safe to display — PII is opaque-filled) plus the
   *  regions used to produce it, so the side panel can render labeled provenance boxes. */
  lastRedactedFrame?: { b64: string; regions: RedactionRegion[]; width: number; height: number };
}

export interface ResourceSample {
  memoryMb?: number;
  lastInferenceMs?: number;
  lastServerRoundTripMs?: number;
  inferenceCallsTotal: number;
  inferenceCallsSkippedByDiff: number;
}

// ----- Sanitized payload sent to the server ---------------------------------

export interface SanitizedContext {
  sessionId: string;
  taskInstruction: string;
  stepIndex: number;
  domStructure: DomNode;
  interactables: InteractableElement[];
  /** base64 PNG, PII regions solid-filled. Never a raw/unredacted frame. */
  redactedScreenshotB64: string;
  redactionSummary: {
    regionCount: number;
    sources: DetectionSource[];
    categories: PiiCategory[];
  };
  rawScreenshotIncluded: false; // literal-false, asserted at the network boundary
}

export interface AgentStepResponse {
  action: AgentAction;
  sessionId: string;
  serverLatencyMs: number;
}

// ----- Message bus envelope --------------------------------------------------

export type BusMessage =
  | { type: 'PING'; payload?: undefined }
  | { type: 'PONG'; payload?: undefined }
  | { type: 'START_TASK'; payload: { instruction: string; mode: AgentMode } }
  | { type: 'STOP_TASK'; payload: { taskId: string } }
  | { type: 'SET_MODE'; payload: { mode: AgentMode } }
  | { type: 'CONFIRM_ACTION'; payload: { taskId: string; approve: boolean } }
  | { type: 'GET_STATE'; payload?: undefined }
  | { type: 'STATE_UPDATE'; payload: TaskState }
  | { type: 'REQUEST_DOM_TAGS'; payload?: undefined }
  | { type: 'DOM_TAGS_RESULT'; payload: DomTagResult }
  | { type: 'EXECUTE_ACTION'; payload: AgentAction }
  | { type: 'ACTION_RESULT'; payload: { ok: boolean; error?: string } }
  | {
      type: 'REDACT_FRAME';
      payload: {
        screenshotDataUrl: string;
        domRegions: RedactionRegion[];
        mediaRegions: BBox[];
        viewport: { width: number; height: number; dpr: number };
      };
    }
  | {
      type: 'REDACT_RESULT';
      payload: {
        redactedB64: string;
        regions: RedactionRegion[];
        inferenceMs: number;
        skippedByDiff: boolean;
        width: number;
        height: number;
        visionError?: string;
      };
    }
  | { type: 'LOG'; payload: TaskLogEntry };

export type BusMessageType = BusMessage['type'];

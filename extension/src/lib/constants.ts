export const SERVER_URL =
  (import.meta as any).env?.VITE_SERVER_URL || 'http://localhost:8000';

/** CSS selectors the DOM pass treats as sensitive. See content/pii-tagging.ts. */
export const SENSITIVE_SELECTORS = [
  'input[type="password"]',
  'input[autocomplete*="cc-"]',
  'input[autocomplete="email"]',
  'input[autocomplete*="street-address"]',
  'input[autocomplete*="postal-code"]',
  'input[name*="ssn" i]',
  'input[name*="aadhaar" i]',
  'input[name*="pan" i]',
  'input[name*="passport" i]',
  'input[name*="card" i]',
  'input[name*="cvv" i]',
  'input[name*="account" i]',
  'input[name*="routing" i]',
  '[aria-label*="password" i]',
  '[aria-label*="card number" i]',
  '[aria-label*="ssn" i]',
  'input[type="tel"]',
  'input[type="email"]',
] as const;

/** Interactive elements the action-executor is allowed to target. */
export const INTERACTABLE_SELECTORS = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[onclick]',
  '[contenteditable="true"]',
].join(',');

export const REDACTION_COLOR = '#000000';
export const REDACTION_OUTLINE_COLOR = '#00D9A3';

export const DEFAULT_MODE = 'assist' as const;

export const STORAGE_KEYS = {
  TASK_STATE: 'sih_task_state',
  MODE: 'sih_agent_mode',
} as const;

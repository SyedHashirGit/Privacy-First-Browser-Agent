import { SENSITIVE_SELECTORS, INTERACTABLE_SELECTORS } from '@/lib/constants';
import type { BBox, DomNode, InteractableElement, RedactionRegion } from '@/lib/types';

// ---------------------------------------------------------------------------
// Tier 1 — DOM-native detection. This is the "sanitize using DOM tags" half
// of the redaction pipeline: it costs microseconds, has near-zero false
// negatives on standard HTML forms, and gives pixel-perfect bounding boxes
// for free via getBoundingClientRect() — no model inference required.
// ---------------------------------------------------------------------------

function toBBox(rect: DOMRect): BBox {
  return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
  return true;
}

/** Also treats plain visible text nodes that *look* like emails/phones/card numbers as sensitive,
 *  since not everything sensitive lives inside an <input>. Cheap regex pass, scoped to leaf text nodes only. */
const TEXT_PII_PATTERNS: RegExp[] = [
  /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i, // email
  /\b(?:\d[ -]?){13,19}\b/, // long digit runs — card-like
  /\b\d{3}[ -]?\d{2}[ -]?\d{4}\b/, // SSN-shaped
  /\b\d{4}\s?\d{4}\s?\d{4}\b/, // aadhaar-shaped
  /(?:\b|\B\+)(?:\d{1,3}[- ]?)?\(?\d{3}\)?[- ]?\d{3}[- ]?\d{4}\b/, // phone
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\b/i, // Date DD Month YYYY
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/i, // Date Month DD YYYY
  /\b\d{2}[-/]\d{2}[-/](?:19|20)\d{2}\b/, // DD/MM/YYYY
  /\b(?:19|20)\d{2}[-/]\d{2}[-/]\d{2}\b/, // YYYY/MM/DD
];

function scanTextNodesForPii(root: Element, regions: RedactionRegion[]) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue?.trim();
      if (!text || text.length < 6) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Node | null;
  let scanned = 0;
  const MAX_SCAN = 4000; // guardrail so a huge page doesn't stall the tagging pass
  while ((node = walker.nextNode()) && scanned < MAX_SCAN) {
    scanned++;
    const text = node.nodeValue!;
    if (!TEXT_PII_PATTERNS.some((re) => re.test(text))) {
      const lower = text.toLowerCase();
      if (!lower.includes('date of birth') && !lower.includes('dob:')) {
        continue;
      }
    }
    const parent = node.parentElement;
    if (!parent || !isVisible(parent)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    regions.push({ box: toBBox(rect), source: 'DOM', label: 'text_pii_pattern' });
    parent.setAttribute('data-sih-redact', 'true');
  }
}

export function runDomTaggingPass(): { regions: RedactionRegion[]; mediaRegions: BBox[]; interactables: InteractableElement[]; domStructure: DomNode } {
  const regions: RedactionRegion[] = [];
  const mediaRegions: BBox[] = [];

  // Clear any stale tags from a previous pass (SPA navigations reuse the same document).
  document.querySelectorAll('[data-sih-redact]').forEach((el) => el.removeAttribute('data-sih-redact'));

  const sensitiveEls = document.querySelectorAll(SENSITIVE_SELECTORS.join(','));
  sensitiveEls.forEach((el) => {
    if (!isVisible(el)) return;
    el.setAttribute('data-sih-redact', 'true');
    regions.push({ box: toBBox(el.getBoundingClientRect()), source: 'DOM', label: describeSelector(el) });
  });

  // <img>/<video> elements are flagged for the vision pass to actually inspect (faces, ID photos) —
  // the DOM only knows "there is media here", not what's in it.
  document.querySelectorAll('img, video').forEach((el) => {
    if (!isVisible(el)) return;
    (el as HTMLElement).setAttribute('data-sih-media-candidate', 'true');
    mediaRegions.push(toBBox(el.getBoundingClientRect()));
  });

  scanTextNodesForPii(document.body, regions);

  const interactables = collectInteractables();
  const domStructure = buildStructuralTree(document.body, 6);

  return { regions, mediaRegions, interactables, domStructure };
}

function describeSelector(el: Element): string {
  const type = el.getAttribute('type');
  if (type === 'password') return 'password_field';
  const autocomplete = el.getAttribute('autocomplete') || '';
  if (autocomplete.includes('cc-')) return 'credit_card_field';
  if (autocomplete === 'email' || type === 'email') return 'email_field';
  if (type === 'tel') return 'phone_field';
  const name = (el.getAttribute('name') || '').toLowerCase();
  if (name.includes('ssn') || name.includes('aadhaar')) return 'national_id_field';
  return 'sensitive_field';
}

function collectInteractables(): InteractableElement[] {
  const els = document.querySelectorAll(INTERACTABLE_SELECTORS);
  const out: InteractableElement[] = [];
  let counter = 0;
  els.forEach((el) => {
    if (!isVisible(el)) return;
    counter++;
    const selector = ensureSelectable(el, counter);
    const sensitive = el.hasAttribute('data-sih-redact');
    out.push({
      selector,
      tag: el.tagName.toLowerCase(),
      text: sensitive ? undefined : (el.textContent || (el as HTMLInputElement).placeholder || '')?.trim().slice(0, 80),
      role: el.getAttribute('role') || undefined,
      box: toBBox(el.getBoundingClientRect()),
      sensitive,
    });
  });
  return out.slice(0, 300); // guardrail
}

/** Gives every interactable a stable, unique attribute selector so the agent can address it later. */
function ensureSelectable(el: Element, counter: number): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const existing = el.getAttribute('data-sih-id');
  if (existing) return `[data-sih-id="${existing}"]`;
  const id = `e${counter}-${Math.random().toString(36).slice(2, 7)}`;
  el.setAttribute('data-sih-id', id);
  return `[data-sih-id="${id}"]`;
}

/** Structural-only tree — tag/id/role/class, no text content — used as context for the VLM. */
function buildStructuralTree(root: Element, depth: number): DomNode {
  const node: DomNode = {
    tag: root.tagName.toLowerCase(),
    id: root.id || undefined,
    role: root.getAttribute('role') || undefined,
    className: typeof root.className === 'string' ? root.className.slice(0, 60) : undefined,
    redacted: root.hasAttribute('data-sih-redact') || undefined,
  };
  if (depth <= 0) return node;
  const children: DomNode[] = [];
  for (const child of Array.from(root.children).slice(0, 40)) {
    if (!isVisible(child)) continue;
    children.push(buildStructuralTree(child, depth - 1));
  }
  if (children.length) node.children = children;
  return node;
}

import type { AgentAction } from '@/lib/types';

// ---------------------------------------------------------------------------
// Executes a single agent action against the live page. Kept deliberately
// dumb and literal — all the "should we do this" judgment (Assist vs
// Autopilot confirmation) happens upstream in the background worker. By the
// time an EXECUTE_ACTION message reaches here, it has already been approved.
// ---------------------------------------------------------------------------

function highlight(el: Element) {
  const rect = el.getBoundingClientRect();
  const box = document.createElement('div');
  box.style.cssText = `
    position: fixed; left:${rect.left}px; top:${rect.top}px;
    width:${rect.width}px; height:${rect.height}px;
    border: 2px solid #00D9A3; border-radius: 4px;
    box-shadow: 0 0 0 3px rgba(0,217,163,0.25);
    z-index: 2147483647; pointer-events: none; transition: opacity 400ms ease;
  `;
  document.documentElement.appendChild(box);
  setTimeout(() => {
    box.style.opacity = '0';
    setTimeout(() => box.remove(), 400);
  }, 700);
}

function findTarget(selector?: string): Element | null {
  if (!selector) return null;
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

export async function executeAction(action: AgentAction): Promise<{ ok: boolean; error?: string }> {
  try {
    switch (action.type) {
      case 'click': {
        const el = findTarget(action.targetSelector) as HTMLElement | null;
        if (!el) return { ok: false, error: `target not found: ${action.targetSelector}` };
        highlight(el);
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await sleep(150);
        el.click();
        return { ok: true };
      }
      case 'type': {
        const el = findTarget(action.targetSelector) as HTMLElement | null;
        if (!el) return { ok: false, error: `target not found: ${action.targetSelector}` };
        if (el.hasAttribute('data-sih-redact')) {
          // Structural safety net: never let the agent (mis)type into a field we
          // ourselves flagged as sensitive, even if it was somehow instructed to.
          return { ok: false, error: 'refused: target is a sensitive field' };
        }
        highlight(el);
        el.focus();
        
        const tagName = el.tagName.toUpperCase();
        if (tagName === 'TEXTAREA' || tagName === 'INPUT') {
          const proto = tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          nativeSetter?.call(el, action.text ?? '');
        } else if (el.isContentEditable) {
          el.textContent = action.text ?? '';
        } else {
          (el as any).value = action.text ?? '';
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      }
      case 'scroll': {
        const el = findTarget(action.targetSelector);
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        else window.scrollBy({ top: 400, behavior: 'smooth' });
        return { ok: true };
      }
      case 'navigate': {
        if (!action.url) return { ok: false, error: 'no url provided' };
        window.location.href = action.url;
        return { ok: true };
      }
      case 'wait': {
        await sleep(500);
        return { ok: true };
      }
      case 'finish':
      case 'ask_user':
        return { ok: true };
      default:
        return { ok: false, error: `unknown action type` };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

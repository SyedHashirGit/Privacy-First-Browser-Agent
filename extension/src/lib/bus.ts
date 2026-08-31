import type { BusMessage, BusMessageType } from './types';

// ---------------------------------------------------------------------------
// A single, typed wrapper around chrome.runtime messaging. Every context
// (content script, background worker, offscreen document, side panel, popup)
// imports this instead of calling chrome.runtime.sendMessage directly.
//
// This exists because unstructured message passing is the #1 source of MV3
// correctness bugs: mismatched payload shapes, forgotten sendResponse calls,
// and races between "worker asleep" and "message sent." Centralizing it here
// means there is exactly one place that knows how routing works.
// ---------------------------------------------------------------------------

type Handler<T extends BusMessage = BusMessage> = (
  message: T,
  sender: chrome.runtime.MessageSender
) => void | Promise<any>;

const handlers = new Map<BusMessageType, Set<Handler>>();

/** Send a message to the background worker (or, from the background worker, broadcast to everyone listening). */
export function send<T extends BusMessage>(message: T): Promise<any> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        // chrome.runtime.lastError fires when there's no listener (e.g. side
        // panel closed). That's an expected, non-fatal case — swallow it.
        void chrome.runtime.lastError;
        resolve(response);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** Send a message to a specific tab's content script. */
export function sendToTab<T extends BusMessage>(tabId: number, message: T): Promise<any> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      void chrome.runtime.lastError;
      resolve(response);
    });
  });
}

/**
 * Register a handler for one message type. The handler's message parameter is
 * narrowed to exactly that message's shape (via Extract), not the full
 * BusMessage union — this is what makes `msg.payload` typecheck correctly at
 * every call site instead of resolving to "payload of some message or other."
 */
export function on<K extends BusMessageType>(
  type: K,
  handler: (
    message: Extract<BusMessage, { type: K }>,
    sender: chrome.runtime.MessageSender
  ) => void | Promise<any>
): () => void {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type)!.add(handler as unknown as Handler);
  return () => handlers.get(type)?.delete(handler as unknown as Handler);
}

let listenerInstalled = false;

/** Call once per context to start dispatching incoming messages to registered handlers. */
export function installBusListener() {
  if (listenerInstalled) return;
  listenerInstalled = true;
  chrome.runtime.onMessage.addListener((message: BusMessage, sender, sendResponse) => {
    const set = handlers.get(message.type);
    if (!set || set.size === 0) return false;

    let usedAsync = false;
    for (const handler of set) {
      const result = handler(message, sender);
      if (result && typeof (result as Promise<any>).then === 'function') {
        usedAsync = true;
        (result as Promise<any>)
          .then((r) => sendResponse(r))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
      }
    }
    // Returning true keeps the message channel open for the async sendResponse above.
    return usedAsync;
  });
}

import { useEffect, useState } from 'react';
import type { TaskState } from '@/lib/types';
import { installBusListener, on, send } from '@/lib/bus';

export default function App() {
  const [state, setState] = useState<TaskState | null>(null);

  useEffect(() => {
    installBusListener();
    on('STATE_UPDATE', (msg) => setState(msg.payload));
    send({ type: 'GET_STATE' }).then((res) => res && setState(res));
  }, []);

  return (
    <div className="bg-base-950 text-ink-50 p-4 font-sans">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2 h-2 rounded-full bg-signal" />
        <h1 className="text-sm font-semibold">Privacy Agent</h1>
      </div>

      <p className="text-xs text-ink-400 mb-3">
        {state ? `Status: ${state.status.replace('_', ' ')}` : 'No active task.'}
      </p>

      <button
        className="w-full bg-signal text-base-950 font-medium rounded-md px-3 py-2 text-sm hover:bg-signal-glow transition-colors"
        onClick={async () => {
          // This is the one call in the whole extension that MUST happen inside
          // the click handler itself. A single immediately-awaited chrome.* call
          // is fine (this is Chrome's own documented pattern) — what silently
          // breaks the user-gesture requirement is inserting unrelated async
          // work (a fetch, a timeout) before calling sidePanel.open().
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id != null) chrome.sidePanel.open({ tabId: tab.id });
        }}
      >
        Open side panel
      </button>
    </div>
  );
}

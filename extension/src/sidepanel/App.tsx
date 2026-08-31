import { useEffect, useState } from 'react';
import { useAgentStore, initStoreSync } from '@/lib/store';
import { RedactionPreview } from './components/RedactionPreview';
import { TaskLog } from './components/TaskLog';
import { ResourceMeter } from './components/ResourceMeter';
import { PrivacyBudget } from './components/PrivacyBudget';
import { ModeToggle } from './components/ModeToggle';
import { ConfirmBar } from './components/ConfirmBar';

export default function App() {
  const { state, startTask, stopTask, setMode, confirmAction } = useAgentStore();
  const [instruction, setInstruction] = useState('');

  useEffect(() => {
    initStoreSync();
  }, []);

  const running = !!state && !['idle', 'done', 'error'].includes(state.status);

  return (
    <div className="h-screen flex flex-col p-3 gap-3">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-sm font-semibold tracking-tight">Privacy Agent</h1>
          <p className="text-[11px] text-ink-500">Local-first · redact-then-send</p>
        </div>
        <ModeToggle mode={state?.mode ?? 'assist'} onChange={setMode} />
      </header>

      <PrivacyBudget state={state} />
      <RedactionPreview state={state} />

      {state?.status === 'awaiting_confirmation' && state.pendingAction && state.mode === 'assist' && (
        <ConfirmBar action={state.pendingAction} onConfirm={confirmAction} />
      )}

      <TaskLog entries={state?.log ?? []} />
      <ResourceMeter resource={state?.resource} />

      <footer className="space-y-2">
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder='e.g. "Fill in the shipping address form and proceed to payment"'
          rows={2}
          disabled={running}
          className="w-full resize-none rounded-md bg-base-800 border border-base-700 px-2.5 py-2 text-xs text-ink-100 placeholder:text-ink-600 focus:outline-none focus:ring-1 focus:ring-signal disabled:opacity-50"
        />
        <div className="flex gap-2">
          {!running ? (
            <button
              className="btn-primary flex-1"
              disabled={!instruction.trim()}
              onClick={() => {
                startTask(instruction.trim(), state?.mode ?? 'assist');
              }}
            >
              Start task
            </button>
          ) : (
            <button className="btn-danger flex-1" onClick={stopTask}>
              Stop
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

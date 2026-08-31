import type { AgentMode } from '@/lib/types';

export function ModeToggle({ mode, onChange }: { mode: AgentMode; onChange: (m: AgentMode) => void }) {
  return (
    <div className="flex items-center gap-1 p-1 rounded-md bg-base-800 border border-base-700">
      {(['assist', 'autopilot'] as AgentMode[]).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={[
            'flex-1 px-2.5 py-1.5 rounded text-xs font-medium transition-colors capitalize',
            mode === m ? 'bg-signal text-base-950' : 'text-ink-400 hover:text-ink-200',
          ].join(' ')}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

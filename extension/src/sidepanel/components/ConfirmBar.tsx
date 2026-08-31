import type { AgentAction } from '@/lib/types';

export function ConfirmBar({
  action,
  onConfirm,
}: {
  action: AgentAction;
  onConfirm: (approve: boolean) => void;
}) {
  return (
    <div className="panel border-amber/40 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-amber animate-pulse-dot" />
        <span className="label-eyebrow text-amber">Awaiting your confirmation</span>
      </div>
      <p className="text-sm text-ink-100">
        <span className="font-mono text-amber">{action.type}</span>
        {action.targetSelector ? <span className="text-ink-400 font-mono text-xs"> {action.targetSelector}</span> : null}
      </p>
      <p className="text-xs text-ink-400">{action.reasoning}</p>
      <div className="flex gap-2 pt-1">
        <button className="btn-primary flex-1" onClick={() => onConfirm(true)}>
          Confirm
        </button>
        <button className="btn-danger flex-1" onClick={() => onConfirm(false)}>
          Decline
        </button>
      </div>
    </div>
  );
}

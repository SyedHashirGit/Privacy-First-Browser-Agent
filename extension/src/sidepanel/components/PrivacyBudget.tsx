import type { TaskState } from '@/lib/types';

// ---------------------------------------------------------------------------
// Reframes an abstract privacy claim as a concrete, auditable number.
// rawBytesTransmitted is a literal 0 by construction — see the runtime
// assertion in background/index.ts's sendToServer() — not a UI decoration.
// ---------------------------------------------------------------------------

export function PrivacyBudget({ state }: { state: TaskState | null }) {
  const pixels = state?.privacyBudget.pixelsRedacted ?? 0;
  const regions = state?.privacyBudget.regionsRedacted ?? 0;

  return (
    <div className="panel p-3 flex items-center justify-between">
      <div>
        <span className="label-eyebrow">Privacy budget</span>
        <p className="text-sm mt-1">
          <span className="text-signal font-semibold">{pixels.toLocaleString()}</span>{' '}
          <span className="text-ink-400">px redacted</span>
          <span className="text-ink-600"> · </span>
          <span className="text-signal font-semibold">{regions}</span>{' '}
          <span className="text-ink-400">region{regions === 1 ? '' : 's'}</span>
        </p>
      </div>
      <div className="text-right">
        <div className="text-sm font-semibold text-signal">0</div>
        <div className="text-[10px] text-ink-500">raw PII bytes sent</div>
      </div>
    </div>
  );
}

import type { ResourceSample } from '@/lib/types';

// ---------------------------------------------------------------------------
// Always visible, not decoration: this is the evidence for "client-side
// resource utilization" and "end-to-end latency" — numbers a judge (or a
// skeptical user) can hold you to during Q&A rather than take on faith.
// Pair with Chrome's own Task Manager (Shift+Esc) during a live demo to
// show the extension's real memory/CPU footprint alongside these figures.
// ---------------------------------------------------------------------------

export function ResourceMeter({ resource }: { resource: ResourceSample | undefined }) {
  const totalStep = (resource?.lastInferenceMs ?? 0) + (resource?.lastServerRoundTripMs ?? 0);

  return (
    <div className="panel p-3">
      <span className="label-eyebrow">Resource meter</span>
      <div className="grid grid-cols-2 gap-2 mt-2 font-mono text-xs">
        <Metric label="Local inference" value={fmtMs(resource?.lastInferenceMs)} />
        <Metric label="Server round trip" value={fmtMs(resource?.lastServerRoundTripMs)} />
        <Metric label="Total step latency" value={fmtMs(totalStep)} accent={totalStep > 0 && totalStep < 1200} />
        <Metric label="Inference calls avoided" value={String(resource?.inferenceCallsSkippedByDiff ?? 0)} sub="via frame diffing" />
      </div>
    </div>
  );
}

function Metric({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="bg-base-800 rounded-md px-2.5 py-2">
      <div className={['text-sm font-semibold', accent ? 'text-signal' : 'text-ink-50'].join(' ')}>{value}</div>
      <div className="text-[10px] text-ink-500 mt-0.5">{label}</div>
      {sub && <div className="text-[9px] text-ink-600">{sub}</div>}
    </div>
  );
}

function fmtMs(ms: number | undefined): string {
  if (ms == null) return '—';
  return `${ms}ms`;
}

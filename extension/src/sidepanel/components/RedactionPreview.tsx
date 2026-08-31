import type { TaskState } from '@/lib/types';

// ---------------------------------------------------------------------------
// Renders the frame AFTER redaction — this is safe to display because every
// PII region in it is already opaque-filled. Overlaying the region boxes on
// top of that (already-safe) frame, labeled by detection source, is what
// turns "we redact PII before sending" from a claim into something a
// person watches happen in real time. See design doc §8.1 — this is
// explicitly called out as the single highest-ROI UI element to build.
// ---------------------------------------------------------------------------

export function RedactionPreview({ state }: { state: TaskState | null }) {
  const busy = state && ['capturing', 'redacting'].includes(state.status);
  const frame = state?.lastRedactedFrame;
  const regionCount = frame?.regions.length ?? 0;

  return (
    <div className="panel p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="label-eyebrow">Live redaction</span>
        <span className={['w-1.5 h-1.5 rounded-full', busy ? 'bg-signal animate-pulse-dot' : 'bg-base-600'].join(' ')} />
      </div>

      <div className="relative aspect-video rounded-md bg-base-950 border border-base-700 overflow-hidden">
        {frame ? (
          <div className="relative w-full h-full">
            <img
              src={`data:image/png;base64,${frame.b64}`}
              alt="Redacted page preview"
              className="w-full h-full object-contain"
              draggable={false}
            />
            {frame.regions.map((r, i) => (
              <RegionBox key={i} region={r} frame={frame} index={i} />
            ))}
          </div>
        ) : (
          <p className="absolute inset-0 flex items-center justify-center text-ink-600 text-xs font-mono px-4 text-center">
            No active capture. Start a task to see redaction happen live, labeled by detection source.
          </p>
        )}
      </div>

      <div className="flex items-center gap-3 mt-2 text-[11px] font-mono">
        <Legend color="border-signal" label="DOM" />
        <Legend color="border-amber" label="VISION" />
        <span className="text-ink-600 ml-auto">{regionCount} region{regionCount === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}

function RegionBox({
  region,
  frame,
  index,
}: {
  region: NonNullable<TaskState['lastRedactedFrame']>['regions'][number];
  frame: NonNullable<TaskState['lastRedactedFrame']>;
  index: number;
}) {
  const left = (region.box.x / frame.width) * 100;
  const top = (region.box.y / frame.height) * 100;
  const width = (region.box.w / frame.width) * 100;
  const height = (region.box.h / frame.height) * 100;
  const color = region.source === 'DOM' ? '#00D9A3' : '#F5B942';

  return (
    <div
      className="absolute border-2 rounded-sm animate-redact-fill flex items-start justify-end p-0.5"
      style={{
        left: `${left}%`,
        top: `${top}%`,
        width: `${width}%`,
        height: `${height}%`,
        borderColor: color,
        animationDelay: `${index * 50}ms`,
      }}
      title={`${region.source}${region.label ? ` · ${region.label}` : ''}`}
    >
      <span
        className="text-[8px] font-mono px-1 rounded-sm leading-tight"
        style={{ backgroundColor: color, color: '#0A0B0D' }}
      >
        {region.source}
      </span>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-ink-400">
      <span className={['w-2 h-2 rounded-sm border-2 bg-transparent', color].join(' ')} />
      {label}
    </span>
  );
}

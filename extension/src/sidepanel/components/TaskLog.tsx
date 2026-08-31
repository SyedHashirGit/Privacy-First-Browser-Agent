import { useEffect, useRef } from 'react';
import type { TaskLogEntry, TaskStepStatus } from '@/lib/types';

const STATUS_COLOR: Record<TaskStepStatus, string> = {
  idle: 'text-ink-500',
  capturing: 'text-ink-200',
  redacting: 'text-signal',
  thinking: 'text-amber',
  awaiting_confirmation: 'text-amber',
  acting: 'text-signal',
  done: 'text-signal',
  error: 'text-alert',
};

export function TaskLog({ entries }: { entries: TaskLogEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries.length]);

  return (
    <div className="panel p-3 flex-1 min-h-0 flex flex-col">
      <span className="label-eyebrow mb-2">Agent log</span>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto font-mono text-xs space-y-2 pr-1">
        {entries.length === 0 && <p className="text-ink-600">Nothing yet — start a task below.</p>}
        {entries.map((e) => (
          <div key={e.id} className="leading-snug">
            <span className="text-ink-600">{new Date(e.timestamp).toLocaleTimeString([], { hour12: false })}</span>{' '}
            <span className={STATUS_COLOR[e.status]}>[{e.status}]</span>{' '}
            <span className="text-ink-200">{e.message}</span>
            {e.action && (
              <div className="pl-4 text-ink-500">
                → {e.action.type}
                {e.action.targetSelector ? ` ${e.action.targetSelector}` : ''}
                {e.action.text ? ` "${e.action.text}"` : ''}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

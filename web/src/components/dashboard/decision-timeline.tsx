'use client';

import { useFetch } from '../../lib/use-fetch';
import { SkeletonTimeline } from './skeleton';

interface Decision {
  id: string;
  goal_id: string;
  goal_name?: string;
  decision: 'proceed' | 'refine' | 'pivot' | 'escalate';
  timestamp: string;
  what_worked?: string[];
  what_failed?: string[];
  suggested_next?: string[];
  strategy_id?: string;
}

const BADGE_COLORS: Record<string, string> = {
  pivot: 'var(--accent-primary)',
  refine: 'var(--status-info)',
  escalate: 'var(--status-error)',
  proceed: 'var(--status-success)',
};

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '--';
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
    + ' ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function summaryText(d: Decision): string {
  if (d.what_failed && d.what_failed.length > 0) return d.what_failed[0];
  if (d.what_worked && d.what_worked.length > 0) return d.what_worked[0];
  if (d.suggested_next && d.suggested_next.length > 0) return d.suggested_next[0];
  return d.strategy_id ? `strategy: ${d.strategy_id.slice(0, 8)}` : '--';
}

export function DecisionTimeline() {
  const { data, loading } = useFetch<Decision[]>('/api/decisions');
  const decisions = data ?? [];

  return (
    <section>
      <h2
        className="font-[family-name:var(--font-geist-sans)]"
        style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)', marginBottom: '12px' }}
      >
        Recent Decisions
      </h2>

      {loading ? (
        <SkeletonTimeline rows={5} />
      ) : decisions.length === 0 ? (
        <p style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>No decisions recorded</p>
      ) : (
        <div className="space-y-0">
          {decisions.map((d) => (
            <div
              key={d.id}
              className="flex items-start gap-3 py-2"
              style={{ borderBottom: '1px solid var(--border-primary)' }}
            >
              <span
                className="font-[family-name:var(--font-geist-mono)] shrink-0"
                style={{ color: 'var(--text-tertiary)', fontSize: '12px', minWidth: '110px' }}
              >
                {formatTimestamp(d.timestamp)}
              </span>
              <span
                className="shrink-0"
                style={{ color: 'var(--text-secondary)', fontSize: '13px', minWidth: '80px' }}
              >
                {d.goal_name || d.goal_id.slice(0, 8)}
              </span>
              <span
                className="shrink-0 uppercase"
                style={{
                  color: BADGE_COLORS[d.decision] || 'var(--text-tertiary)',
                  fontSize: '11px',
                  fontWeight: 500,
                  minWidth: '64px',
                }}
              >
                {d.decision}
              </span>
              <span
                className="truncate"
                style={{ color: 'var(--text-secondary)', fontSize: '13px' }}
              >
                {summaryText(d)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

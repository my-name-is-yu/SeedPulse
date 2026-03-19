'use client';

import Link from 'next/link';
import { relativeTime } from '../../lib/format-time';
import { SkeletonTable } from './skeleton';

interface GoalDimension {
  name: string;
  current_value?: number;
  threshold?: { type: string; value: number };
}

export interface GoalRow {
  id: string;
  name?: string;
  dimensions?: GoalDimension[];
  status?: string;
  updated_at?: string;
  created_at?: string;
  trust_score?: number | null;
  strategy_state?: string | null;
}

function computeGapPercent(dimensions?: GoalDimension[]): number | null {
  if (!dimensions || dimensions.length === 0) return null;
  const gaps = dimensions.map((d) => {
    const current = d.current_value ?? 0;
    const target = d.threshold?.value ?? 1;
    if (target === 0) return 0;
    return Math.max(0, Math.min(1, Math.abs(target - current) / Math.abs(target)));
  });
  return Math.max(...gaps);
}

function gapColor(pct: number): string {
  if (pct <= 0.3) return 'var(--status-success)';
  if (pct <= 0.6) return 'var(--accent-primary)';
  return 'var(--status-error)';
}

function trustColor(score: number | null | undefined): string {
  if (score == null) return 'var(--text-tertiary)';
  if (score < 0) return 'var(--trust-negative)';
  if (score <= 20) return 'var(--trust-neutral)';
  return 'var(--trust-positive)';
}

const headerStyle: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  color: 'var(--text-secondary)',
  fontSize: '11px',
  fontWeight: 400,
  padding: '8px 0',
  borderBottom: '1px solid var(--border-primary)',
};

export function GoalTable({ goals, loading }: { goals: GoalRow[]; loading: boolean }) {
  if (loading) return <SkeletonTable rows={4} />;

  if (goals.length === 0) {
    return <p style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>No goals found</p>;
  }

  return (
    <table className="w-full" style={{ borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          {['Goal', 'Gap %', 'Trust', 'Strategy', 'Updated'].map((h) => (
            <th key={h} className="text-left" style={headerStyle}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {goals.map((g) => {
          const gap = computeGapPercent(g.dimensions);
          const gapPct = gap != null ? Math.round(gap * 100) : null;

          return (
            <tr key={g.id} style={{ borderBottom: '1px solid var(--border-primary)' }}>
              <td className="py-2" style={{ fontSize: '13px' }}>
                <Link href={`/goals/${g.id}`} style={{ color: 'var(--text-primary)' }}>
                  {g.name || g.id}
                </Link>
              </td>
              <td className="py-2" style={{ minWidth: '120px' }}>
                {gapPct != null ? (
                  <div className="flex items-center gap-2">
                    <span
                      className="font-[family-name:var(--font-geist-mono)]"
                      style={{ fontSize: '13px', fontWeight: 700, color: gapColor(gap!) }}
                    >
                      {gapPct}%
                    </span>
                    <div
                      className="flex-1 rounded-sm overflow-hidden"
                      style={{ height: '4px', background: 'var(--bg-tertiary)', maxWidth: '80px' }}
                    >
                      <div
                        className="h-full rounded-sm"
                        style={{ width: `${gapPct}%`, background: gapColor(gap!) }}
                      />
                    </div>
                  </div>
                ) : (
                  <span style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>--</span>
                )}
              </td>
              <td className="py-2">
                <span
                  className="font-[family-name:var(--font-geist-mono)]"
                  style={{ fontSize: '13px', fontWeight: 700, color: trustColor(g.trust_score) }}
                >
                  {g.trust_score != null ? (g.trust_score >= 0 ? `+${g.trust_score}` : g.trust_score) : '--'}
                </span>
              </td>
              <td className="py-2" style={{ fontSize: '13px' }}>
                {g.strategy_state ? (
                  <span className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full"
                      style={{
                        background: g.strategy_state === 'active'
                          ? 'var(--status-success)'
                          : g.strategy_state === 'stalled'
                            ? 'var(--status-stalled)'
                            : 'var(--text-tertiary)',
                      }}
                    />
                    <span style={{ color: 'var(--text-secondary)' }}>{g.strategy_state}</span>
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-tertiary)' }}>--</span>
                )}
              </td>
              <td className="py-2" style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>
                {relativeTime(g.updated_at || g.created_at || '')}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

'use client';

import { useFetch } from '../../lib/use-fetch';
import { elapsedTime } from '../../lib/format-time';
import { SkeletonTable } from './skeleton';

interface Session {
  id: string;
  session_type?: string;
  goal_id?: string;
  status: string;
  adapter_type?: string;
  created_at: string;
  current_stage?: string;
}

const STAGES = ['observe', 'gap', 'score', 'task', 'execute', 'verify'] as const;

function StageIndicator({ current }: { current?: string }) {
  const idx = STAGES.indexOf(current as (typeof STAGES)[number]);

  return (
    <div className="flex items-center gap-1">
      {STAGES.map((stage, i) => (
        <div
          key={stage}
          className="rounded-full"
          title={stage}
          style={{
            width: i === idx ? '8px' : '6px',
            height: i === idx ? '8px' : '6px',
            background: i === idx
              ? 'var(--accent-primary)'
              : i < idx
                ? 'var(--text-tertiary)'
                : 'var(--bg-tertiary)',
            transition: 'all 0.2s',
          }}
        />
      ))}
    </div>
  );
}

export function ActiveSessions() {
  const { data, loading } = useFetch<Session[]>('/api/sessions');
  const active = (data ?? []).filter((s) => s.status === 'active');

  return (
    <section>
      <h2
        className="font-[family-name:var(--font-geist-sans)]"
        style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)', marginBottom: '12px' }}
      >
        Active Sessions
      </h2>

      {loading ? (
        <SkeletonTable rows={2} cols={4} />
      ) : active.length === 0 ? (
        <p style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>No active sessions</p>
      ) : (
        <div className="space-y-0">
          {active.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between py-2"
              style={{ borderBottom: '1px solid var(--border-primary)' }}
            >
              <div className="flex items-center gap-4">
                <span style={{ color: 'var(--text-primary)', fontSize: '13px' }}>
                  {s.adapter_type || 'unknown'}
                </span>
                <span style={{ color: 'var(--text-tertiary)', fontSize: '11px' }}>
                  {s.session_type || 'task'}
                </span>
                <StageIndicator current={s.current_stage} />
              </div>
              <span
                className="font-[family-name:var(--font-geist-mono)]"
                style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}
              >
                {elapsedTime(s.created_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

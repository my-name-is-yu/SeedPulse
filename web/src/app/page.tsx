'use client';

import { useFetch } from '../lib/use-fetch';
import { GoalTable, type GoalRow } from '../components/dashboard/goal-table';
import { ActiveSessions } from '../components/dashboard/active-sessions';
import { DecisionTimeline } from '../components/dashboard/decision-timeline';

export default function DashboardPage() {
  const { data, loading } = useFetch<GoalRow[]>('/api/goals');
  const goals = Array.isArray(data) ? data : [];

  return (
    <div className="space-y-8">
      <h1
        className="font-[family-name:var(--font-geist-sans)]"
        style={{ fontSize: '20px', fontWeight: 600, color: 'var(--text-primary)' }}
      >
        Dashboard
      </h1>

      {/* Upper: Goal overview table */}
      <section>
        <GoalTable goals={goals} loading={loading} />
      </section>

      {/* Middle: Active sessions */}
      <ActiveSessions />

      {/* Lower: Decision timeline */}
      <DecisionTimeline />
    </div>
  );
}

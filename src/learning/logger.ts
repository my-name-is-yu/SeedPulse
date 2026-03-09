import { z } from 'zod';
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export const ActionLogEntry = z.object({
  timestamp: z.string(),
  session_id: z.string(),
  goal_id: z.string().optional(),
  state_before: z.record(z.number()).optional(),
  action: z.object({
    tool: z.string(),
    target: z.string().optional(),
  }),
  state_after: z.record(z.number()).optional(),
  state_delta: z.record(z.number()).optional(),
  outcome: z.enum(['success', 'failure', 'skipped']),
});
export type ActionLogEntry = z.infer<typeof ActionLogEntry>;

export class ActionLogger {
  constructor(private logPath: string) {}

  createEntry(params: {
    sessionId: string;
    goalId?: string;
    stateBefore?: Record<string, number>;
    action: { tool: string; target?: string };
    stateAfter?: Record<string, number>;
    outcome: 'success' | 'failure' | 'skipped';
  }): ActionLogEntry {
    const delta = this.computeDelta(params.stateBefore, params.stateAfter);

    const entry: ActionLogEntry = {
      timestamp: new Date().toISOString(),
      session_id: params.sessionId,
      action: params.action,
      outcome: params.outcome,
    };

    if (params.goalId !== undefined) entry.goal_id = params.goalId;
    if (params.stateBefore !== undefined) entry.state_before = params.stateBefore;
    if (params.stateAfter !== undefined) entry.state_after = params.stateAfter;
    if (Object.keys(delta).length > 0) entry.state_delta = delta;

    return ActionLogEntry.parse(entry);
  }

  append(entry: ActionLogEntry): void {
    mkdirSync(dirname(this.logPath), { recursive: true });
    appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
  }

  readRecent(limit = 100): ActionLogEntry[] {
    if (!existsSync(this.logPath)) return [];

    const raw = readFileSync(this.logPath, 'utf-8');
    const lines = raw
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);

    const recent = lines.slice(-limit);
    const entries: ActionLogEntry[] = [];

    for (const line of recent) {
      try {
        entries.push(ActionLogEntry.parse(JSON.parse(line)));
      } catch {
        // skip malformed lines
      }
    }

    return entries;
  }

  private computeDelta(
    before?: Record<string, number>,
    after?: Record<string, number>,
  ): Record<string, number> {
    if (!before || !after) return {};

    const delta: Record<string, number> = {};
    for (const key of Object.keys(after)) {
      if (key in before) {
        const d = after[key] - before[key];
        if (Math.abs(d) > 1e-10) {
          delta[key] = d;
        }
      }
    }
    return delta;
  }
}

import { parseArgs } from "node:util";
import type { ScheduleEngine } from "../../../../runtime/schedule/engine.js";

function parsePeriodMs(period: string): number {
  const match = /^(\d+)([dhw])$/.exec(period.trim());
  if (!match) {
    throw new Error("period must look like 7d, 24h, or 2w");
  }
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("period value must be positive");
  }
  if (unit === "h") return value * 60 * 60 * 1000;
  if (unit === "w") return value * 7 * 24 * 60 * 60 * 1000;
  return value * 24 * 60 * 60 * 1000;
}

export async function scheduleCost(engine: ScheduleEngine, argv: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        period: { type: "string", default: "7d" },
      },
      strict: false,
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return;
  }

  let periodMs: number;
  const period = String(parsed.values.period ?? "7d");
  try {
    periodMs = parsePeriodMs(period);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return;
  }

  const sinceMs = Date.now() - periodMs;
  const history = (await engine.getRecentHistory(5000))
    .filter((record) => new Date(record.finished_at).getTime() >= sinceMs);
  const entries = engine.getEntries();
  const byEntry = new Map<string, { name: string; layer: string; executions: number; tokens: number }>();

  for (const entry of entries) {
    byEntry.set(entry.id, {
      name: entry.name,
      layer: entry.layer,
      executions: 0,
      tokens: 0,
    });
  }

  for (const record of history) {
    const current = byEntry.get(record.entry_id) ?? {
      name: record.entry_name,
      layer: record.layer ?? "unknown",
      executions: 0,
      tokens: 0,
    };
    current.executions += 1;
    current.tokens += record.tokens_used ?? 0;
    byEntry.set(record.entry_id, current);
  }

  const rows = Array.from(byEntry.entries())
    .map(([entryId, row]) => ({ entryId, ...row }))
    .filter((row) => row.executions > 0 || row.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name));
  const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  const totalExecutions = rows.reduce((sum, row) => sum + row.executions, 0);

  console.log(`Schedule cost summary (${period})`);
  console.log(`  executions: ${totalExecutions}`);
  console.log(`  tokens:     ${totalTokens}`);

  if (rows.length === 0) {
    console.log("  no schedule executions in this period");
    return;
  }

  for (const row of rows) {
    console.log(
      `  ${row.entryId.slice(0, 8)}  [${row.layer}] ${row.name}  executions=${row.executions}  tokens=${row.tokens}`
    );
  }
}

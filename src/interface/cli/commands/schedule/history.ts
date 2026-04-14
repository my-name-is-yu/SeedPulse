import { parseArgs } from "node:util";
import type { ScheduleEngine } from "../../../../runtime/schedule/engine.js";
import { getScheduleOrPrintError, parsePositiveInteger } from "./shared.js";

export async function scheduleHistory(engine: ScheduleEngine, argv: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        limit: { type: "string", default: "10" },
      },
      strict: false,
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return;
  }

  const entry = getScheduleOrPrintError(engine, parsed.positionals[0]);
  if (!entry) return;

  try {
    const limit = parsePositiveInteger(String(parsed.values.limit ?? "10"), "--limit");
    const records = await engine.getRecentHistory(limit, entry.id);
    if (records.length === 0) {
      console.log(`No schedule history for ${entry.id} (${entry.name}).`);
      return;
    }
    for (const record of records) {
      const error = record.error_message ? ` error=${record.error_message}` : "";
      const output = record.output_summary ? ` output=${record.output_summary}` : "";
      console.log(
        `  ${record.fired_at}  ${record.reason}  ${record.status}  attempt=${record.attempt}${error}${output}`
      );
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
  }
}

import { parseArgs } from "node:util";
import type { StateManager } from "../../../../base/state/state-manager.js";
import type { CharacterConfigManager } from "../../../../platform/traits/character-config.js";
import { DaemonClient, isDaemonRunning } from "../../../../runtime/daemon/client.js";
import { ScheduleEngine } from "../../../../runtime/schedule/engine.js";
import type { ScheduleEntry } from "../../../../runtime/types/schedule.js";
import { buildDeps } from "../../setup.js";
import { getCliLogger } from "../../cli-logger.js";
import { getScheduleOrPrintError } from "./shared.js";

async function buildScheduleRunEngine(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager | undefined,
  entry: ScheduleEntry,
  allowEscalation: boolean,
): Promise<ScheduleEngine> {
  const canRunWithLocalDeps =
    !allowEscalation &&
    (entry.layer === "heartbeat" ||
      (entry.layer === "cron" && entry.cron?.job_kind === "soil_publish"));

  if (!characterConfigManager || canRunWithLocalDeps) {
    const engine = new ScheduleEngine({ baseDir: stateManager.getBaseDir() });
    await engine.loadEntries();
    return engine;
  }

  const deps = await buildDeps(
    stateManager,
    characterConfigManager,
    undefined,
    undefined,
    getCliLogger(),
  );
  const engine = new ScheduleEngine({
    baseDir: stateManager.getBaseDir(),
    logger: getCliLogger(),
    dataSourceRegistry: deps.dataSourceRegistry,
    llmClient: deps.llmClient,
    coreLoop: deps.coreLoop,
    stateManager: deps.stateManager,
    reportingEngine: deps.reportingEngine,
    hookManager: deps.hookManager,
    memoryLifecycle: deps.memoryLifecycleManager,
    knowledgeManager: deps.knowledgeManager,
  });
  await engine.loadEntries();
  return engine;
}

async function requestDaemonRunNow(
  stateManager: StateManager,
  entry: ScheduleEntry,
  allowEscalation: boolean,
): Promise<boolean> {
  const daemon = await isDaemonRunning(stateManager.getBaseDir());
  if (!daemon.running) {
    return false;
  }

  const client = new DaemonClient({
    host: "127.0.0.1",
    port: daemon.port,
    authToken: daemon.authToken,
    baseDir: stateManager.getBaseDir(),
  });
  await client.runScheduleNow(entry.id, { allowEscalation });
  console.log(`Requested daemon schedule run: ${entry.id} (${entry.name})`);
  return true;
}

export async function scheduleRunNow(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager | undefined,
  fallbackEngine: ScheduleEngine,
  argv: string[],
): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "with-escalation": { type: "boolean" },
      },
      strict: false,
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return;
  }

  const id = parsed.positionals[0];
  const preflightEntry = getScheduleOrPrintError(fallbackEngine, id);
  if (!preflightEntry) return;

  try {
    const allowEscalation = parsed.values["with-escalation"] === true;
    const daemonAccepted = await requestDaemonRunNow(stateManager, preflightEntry, allowEscalation);
    if (daemonAccepted) return;

    const runEngine = await buildScheduleRunEngine(
      stateManager,
      characterConfigManager,
      preflightEntry,
      allowEscalation,
    );
    const entry = getScheduleOrPrintError(runEngine, preflightEntry.id);
    if (!entry) return;

    const result = await runEngine.runEntryNow(entry.id, {
      allowEscalation,
      preserveEnabled: true,
    });
    if (!result) {
      console.error(`No schedule entry found matching: ${id}`);
      return;
    }

    const summary = result.result.output_summary ? `: ${result.result.output_summary}` : "";
    console.log(`Ran schedule entry: ${entry.id} (${entry.name}) -> ${result.result.status}${summary}`);
    if (result.result.error_message) {
      console.error(`Error: ${result.result.error_message}`);
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
  }
}

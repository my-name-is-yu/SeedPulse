import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { ScheduleEngine } from "../../../runtime/schedule-engine.js";
import { DreamScheduleSuggestionStore } from "../dream-schedule-suggestions.js";

describe("DreamScheduleSuggestionStore", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("dream-suggestions-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  async function writeSuggestions(payload: unknown): Promise<void> {
    await fs.mkdir(path.join(tempDir, "dream"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "dream", "schedule-suggestions.json"),
      JSON.stringify(payload, null, 2),
      "utf8",
    );
  }

  it("normalizes legacy suggestions into pending review items", async () => {
    await writeSuggestions({
      generated_at: "2026-04-08T00:00:00.000Z",
      suggestions: [
        {
          type: "goal_trigger",
          goalId: "goal-1",
          proposal: "0 9 * * *",
          reason: "Manual execution clusters around 09:00 UTC.",
          confidence: 0.8,
        },
      ],
    });

    const store = new DreamScheduleSuggestionStore(tempDir);
    const suggestions = await store.list();

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.id).toBeTruthy();
    expect(suggestions[0]?.status).toBe("pending");
  });

  it("applies a pending dream suggestion into a real schedule entry", async () => {
    await writeSuggestions({
      generated_at: "2026-04-08T00:00:00.000Z",
      suggestions: [
        {
          id: "dream-1",
          type: "goal_trigger",
          goalId: "goal-1",
          name: "Dream goal trigger: goal-1",
          trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
          proposal: "0 9 * * *",
          reason: "Manual execution clusters around 09:00 UTC.",
          confidence: 0.8,
          status: "pending",
        },
      ],
    });

    const store = new DreamScheduleSuggestionStore(tempDir);
    const engine = new ScheduleEngine({ baseDir: tempDir });
    await engine.loadEntries();

    const result = await store.applySuggestion("dream-1", engine);

    expect(result.duplicate).toBe(false);
    expect(result.entry.layer).toBe("goal_trigger");
    expect(result.entry.goal_trigger?.goal_id).toBe("goal-1");
    expect(result.entry.metadata).toEqual(expect.objectContaining({
      source: "dream",
      dream_suggestion_id: "dream-1",
    }));

    const suggestions = await store.list();
    expect(suggestions[0]).toEqual(expect.objectContaining({
      id: "dream-1",
      status: "applied",
      applied_entry_id: result.entry.id,
    }));
  });

  it("reuses an equivalent existing schedule entry instead of duplicating it", async () => {
    await writeSuggestions({
      generated_at: "2026-04-08T00:00:00.000Z",
      suggestions: [
        {
          id: "dream-dup",
          type: "goal_trigger",
          goalId: "goal-1",
          name: "Dream goal trigger: goal-1",
          trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
          proposal: "0 9 * * *",
          reason: "Manual execution clusters around 09:00 UTC.",
          confidence: 0.8,
          status: "pending",
        },
      ],
    });

    const engine = new ScheduleEngine({ baseDir: tempDir });
    await engine.loadEntries();
    const existing = await engine.addEntry({
      name: "Existing goal trigger",
      layer: "goal_trigger",
      trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      enabled: true,
      metadata: {
        source: "manual",
        dependency_hints: [],
      },
      goal_trigger: {
        goal_id: "goal-1",
        max_iterations: 10,
        skip_if_active: true,
      },
    });

    const store = new DreamScheduleSuggestionStore(tempDir);
    const result = await store.applySuggestion("dream-dup", engine);

    expect(result.duplicate).toBe(true);
    expect(result.entry.id).toBe(existing.id);
    expect(engine.getEntries()).toHaveLength(1);
  });

  it("marks suggestions as rejected or dismissed", async () => {
    await writeSuggestions({
      generated_at: "2026-04-08T00:00:00.000Z",
      suggestions: [
        {
          id: "dream-reject",
          type: "goal_trigger",
          goalId: "goal-1",
          proposal: "0 9 * * *",
          reason: "Manual execution clusters around 09:00 UTC.",
          confidence: 0.8,
          status: "pending",
        },
      ],
    });

    const store = new DreamScheduleSuggestionStore(tempDir);
    const rejected = await store.markDecision("dream-reject", "rejected", "not useful");

    expect(rejected.status).toBe("rejected");
    expect(rejected.decision_reason).toBe("not useful");
  });
});

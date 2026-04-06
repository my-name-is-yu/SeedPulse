import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  appendWALRecord,
  readWAL,
  replayWAL,
  compactWAL,
  truncateWAL,
  type WALIntent,
} from "../state-wal.js";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";

const GOAL_ID = "test-goal-1";

function makeIntent(op = "save_goal", ts?: string): WALIntent {
  return { op, data: { value: 42 }, ts: ts ?? new Date().toISOString() };
}

describe("state-wal", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-wal-test-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  describe("appendWALRecord + readWAL", () => {
    it("round-trips a single intent", async () => {
      const intent = makeIntent("save_goal", "2026-01-01T00:00:00.000Z");
      await appendWALRecord(GOAL_ID, tmpDir, intent);
      const records = await readWAL(GOAL_ID, tmpDir);
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual(intent);
    });

    it("appends multiple records", async () => {
      const i1 = makeIntent("save_goal", "2026-01-01T00:00:00.000Z");
      const i2 = makeIntent("save_observation", "2026-01-01T00:00:01.000Z");
      await appendWALRecord(GOAL_ID, tmpDir, i1);
      await appendWALRecord(GOAL_ID, tmpDir, i2);
      const records = await readWAL(GOAL_ID, tmpDir);
      expect(records).toHaveLength(2);
      expect(records[0]).toEqual(i1);
      expect(records[1]).toEqual(i2);
    });

    it("creates goal dir automatically", async () => {
      const goalDir = path.join(tmpDir, "goals", GOAL_ID);
      expect(fs.existsSync(goalDir)).toBe(false);
      await appendWALRecord(GOAL_ID, tmpDir, makeIntent());
      expect(fs.existsSync(goalDir)).toBe(true);
    });
  });

  describe("readWAL", () => {
    it("returns [] for missing WAL file", async () => {
      const records = await readWAL(GOAL_ID, tmpDir);
      expect(records).toEqual([]);
    });

    it("returns [] for empty WAL file", async () => {
      const goalDir = path.join(tmpDir, "goals", GOAL_ID);
      fs.mkdirSync(goalDir, { recursive: true });
      fs.writeFileSync(path.join(goalDir, "wal.jsonl"), "", "utf-8");
      const records = await readWAL(GOAL_ID, tmpDir);
      expect(records).toEqual([]);
    });
  });

  describe("replayWAL", () => {
    it("returns 0 for missing WAL", async () => {
      const count = await replayWAL(GOAL_ID, tmpDir, async () => {});
      expect(count).toBe(0);
    });

    it("replays intent without a matching commit", async () => {
      const intent = makeIntent("save_goal", "2026-01-01T00:00:00.000Z");
      await appendWALRecord(GOAL_ID, tmpDir, intent);
      const applied: WALIntent[] = [];
      const count = await replayWAL(GOAL_ID, tmpDir, async (i) => { applied.push(i); });
      expect(count).toBe(1);
      expect(applied[0]).toEqual(intent);
    });

    it("does NOT replay intent with a matching commit", async () => {
      const ts = "2026-01-01T00:00:00.000Z";
      const intent = makeIntent("save_goal", ts);
      await appendWALRecord(GOAL_ID, tmpDir, intent);
      await appendWALRecord(GOAL_ID, tmpDir, {
        op: "commit",
        ref_ts: ts,
        ts: "2026-01-01T00:00:01.000Z",
      });
      const count = await replayWAL(GOAL_ID, tmpDir, async () => {});
      expect(count).toBe(0);
    });

    it("replays only uncommitted intents from interleaved records", async () => {
      const ts1 = "2026-01-01T00:00:00.000Z";
      const ts2 = "2026-01-01T00:00:02.000Z";
      await appendWALRecord(GOAL_ID, tmpDir, makeIntent("save_goal", ts1));
      await appendWALRecord(GOAL_ID, tmpDir, { op: "commit", ref_ts: ts1, ts: "2026-01-01T00:00:01.000Z" });
      await appendWALRecord(GOAL_ID, tmpDir, makeIntent("save_observation", ts2));
      const applied: WALIntent[] = [];
      const count = await replayWAL(GOAL_ID, tmpDir, async (i) => { applied.push(i); });
      expect(count).toBe(1);
      expect(applied[0].ts).toBe(ts2);
    });
  });

  describe("compactWAL", () => {
    it("removes committed entries, keeps uncommitted", async () => {
      const ts1 = "2026-01-01T00:00:00.000Z";
      const ts2 = "2026-01-01T00:00:02.000Z";
      await appendWALRecord(GOAL_ID, tmpDir, makeIntent("save_goal", ts1));
      await appendWALRecord(GOAL_ID, tmpDir, { op: "commit", ref_ts: ts1, ts: "2026-01-01T00:00:01.000Z" });
      await appendWALRecord(GOAL_ID, tmpDir, makeIntent("save_observation", ts2));
      await compactWAL(GOAL_ID, tmpDir);
      const records = await readWAL(GOAL_ID, tmpDir);
      // After compaction: compaction_complete + uncommitted intent
      const intents = records.filter((r) => r.op !== "compaction_start" && r.op !== "compaction_complete" && r.op !== "commit");
      expect(intents).toHaveLength(1);
      expect((intents[0] as WALIntent).ts).toBe(ts2);
    });

    it("handles crash during compaction (compaction_start without complete)", async () => {
      const ts1 = "2026-01-01T00:00:00.000Z";
      const intent = makeIntent("save_goal", ts1);
      await appendWALRecord(GOAL_ID, tmpDir, intent);
      await appendWALRecord(GOAL_ID, tmpDir, { op: "commit", ref_ts: ts1, ts: "2026-01-01T00:00:01.000Z" });
      // Simulate crash: compaction_start written but no complete
      await appendWALRecord(GOAL_ID, tmpDir, { op: "compaction_start", ts: "2026-01-01T00:00:02.000Z" });
      // Re-run compaction (simulates restart recovery)
      await compactWAL(GOAL_ID, tmpDir);
      const records = await readWAL(GOAL_ID, tmpDir);
      const intents = records.filter((r) => r.op !== "compaction_start" && r.op !== "compaction_complete" && r.op !== "commit");
      expect(intents).toHaveLength(0);
      const complete = records.filter((r) => r.op === "compaction_complete");
      expect(complete.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("truncateWAL", () => {
    it("empties an existing WAL file", async () => {
      await appendWALRecord(GOAL_ID, tmpDir, makeIntent());
      await truncateWAL(GOAL_ID, tmpDir);
      const records = await readWAL(GOAL_ID, tmpDir);
      expect(records).toEqual([]);
    });

    it("does not throw for missing WAL file", async () => {
      await expect(truncateWAL(GOAL_ID, tmpDir)).resolves.not.toThrow();
    });
  });
});

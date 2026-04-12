import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  loadDreamActivationArtifacts,
  upsertDreamActivationArtifacts,
} from "../dream-activation-artifacts.js";

describe("dream activation artifacts", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
    tmpDir = "";
  });

  it("loads missing or malformed activation artifact files as empty", async () => {
    tmpDir = makeTempDir("dream-activation-artifacts-empty-");

    await expect(loadDreamActivationArtifacts(tmpDir)).resolves.toEqual([]);

    await fs.mkdir(path.join(tmpDir, "dream"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "dream", "activation-artifacts.json"), "{", "utf8");

    await expect(loadDreamActivationArtifacts(tmpDir)).resolves.toEqual([]);
  });

  it("upserts artifacts idempotently by artifact id", async () => {
    tmpDir = makeTempDir("dream-activation-artifacts-upsert-");
    const artifact = {
      artifact_id: "artifact-1",
      type: "workflow_hint_pack" as const,
      source: "test",
      scope: {},
      summary: "Use known recovery workflows",
      payload: { workflow_ids: ["wf-1"] },
      evidence_refs: ["dream/events/goal-a.jsonl#L1"],
      confidence: 0.8,
      valid_from: "2026-04-12T00:00:00.000Z",
      valid_to: null,
    };

    await upsertDreamActivationArtifacts(tmpDir, [artifact], "2026-04-12T01:00:00.000Z");
    await upsertDreamActivationArtifacts(tmpDir, [{ ...artifact, confidence: 0.9 }], "2026-04-12T02:00:00.000Z");

    await expect(loadDreamActivationArtifacts(tmpDir)).resolves.toEqual([
      expect.objectContaining({
        artifact_id: "artifact-1",
        confidence: 0.9,
      }),
    ]);
  });
});

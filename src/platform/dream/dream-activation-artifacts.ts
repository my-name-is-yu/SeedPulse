import * as path from "node:path";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../base/utils/json-io.js";
import {
  DreamActivationArtifactFileSchema,
  DreamActivationArtifactSchema,
  type DreamActivationArtifact,
} from "./dream-types.js";

function activationArtifactPath(baseDir: string): string {
  return path.join(baseDir, "dream", "activation-artifacts.json");
}

export async function loadDreamActivationArtifacts(baseDir: string): Promise<DreamActivationArtifact[]> {
  const raw = await readJsonFileOrNull(activationArtifactPath(baseDir));
  if (raw === null) {
    return [];
  }
  const parsed = DreamActivationArtifactFileSchema.safeParse(raw);
  return parsed.success ? parsed.data.artifacts : [];
}

export async function replaceDreamActivationArtifacts(
  baseDir: string,
  artifacts: DreamActivationArtifact[],
  generatedAt: string = new Date().toISOString()
): Promise<void> {
  const unique = new Map<string, DreamActivationArtifact>();
  for (const artifact of artifacts) {
    unique.set(artifact.artifact_id, DreamActivationArtifactSchema.parse(artifact));
  }
  await writeJsonFileAtomic(
    activationArtifactPath(baseDir),
    DreamActivationArtifactFileSchema.parse({
      generated_at: generatedAt,
      artifacts: [...unique.values()].sort((left, right) => left.artifact_id.localeCompare(right.artifact_id)),
    })
  );
}

export async function upsertDreamActivationArtifacts(
  baseDir: string,
  artifacts: DreamActivationArtifact[],
  generatedAt: string = new Date().toISOString()
): Promise<DreamActivationArtifact[]> {
  const existing = await loadDreamActivationArtifacts(baseDir);
  const byId = new Map(existing.map((artifact) => [artifact.artifact_id, artifact]));
  for (const artifact of artifacts) {
    byId.set(artifact.artifact_id, DreamActivationArtifactSchema.parse(artifact));
  }
  const next = [...byId.values()].sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
  await replaceDreamActivationArtifacts(baseDir, next, generatedAt);
  return next;
}

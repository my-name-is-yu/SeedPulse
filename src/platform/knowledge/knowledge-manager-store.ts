import {
  KnowledgeEntrySchema,
  DomainKnowledgeSchema,
  SharedKnowledgeEntrySchema,
} from "../../base/types/knowledge.js";
import type {
  DomainKnowledge,
  DomainStability,
  KnowledgeEntry,
  SharedKnowledgeEntry,
} from "../../base/types/knowledge.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { VectorIndex } from "./vector-index.js";
import { computeRevalidationDue } from "./knowledge-revalidation.js";
import { loadSharedEntries } from "./knowledge-search.js";
import { SHARED_KB_PATH } from "./knowledge-manager-internals.js";

export interface KnowledgeStoreHost {
  stateManager: StateManager;
  vectorIndex?: VectorIndex;
  loadDomainKnowledge(goalId: string): Promise<DomainKnowledge>;
  projectDomainKnowledge(goalId: string, domainKnowledge: DomainKnowledge): Promise<void>;
  projectSharedKnowledge(entries: SharedKnowledgeEntry[]): Promise<void>;
}

export async function saveDomainKnowledgeEntry(
  host: KnowledgeStoreHost,
  goalId: string,
  entry: KnowledgeEntry
): Promise<void> {
  const parsed = KnowledgeEntrySchema.parse(entry);
  const domainKnowledge = await host.loadDomainKnowledge(goalId);
  domainKnowledge.entries.push(parsed);
  domainKnowledge.last_updated = new Date().toISOString();
  const validated = DomainKnowledgeSchema.parse(domainKnowledge);

  if (host.vectorIndex) {
    await host.vectorIndex.add(
      parsed.entry_id,
      `${parsed.question} ${parsed.answer}`,
      { goal_id: goalId, tags: parsed.tags }
    );
  }

  try {
    await host.stateManager.writeRaw(`goals/${goalId}/domain_knowledge.json`, validated);
    await host.projectDomainKnowledge(goalId, validated);
  } catch (err) {
    if (host.vectorIndex) {
      await host.vectorIndex.remove(parsed.entry_id);
    }
    throw err;
  }
}

export async function saveSharedKnowledgeEntry(
  host: Pick<KnowledgeStoreHost, "stateManager" | "vectorIndex" | "projectSharedKnowledge">,
  entry: KnowledgeEntry,
  goalId: string,
  defaultStability: DomainStability = "moderate"
): Promise<SharedKnowledgeEntry> {
  const now = new Date();
  const shared = SharedKnowledgeEntrySchema.parse({
    ...entry,
    source_goal_ids: [goalId],
    domain_stability: defaultStability,
    revalidation_due_at: computeRevalidationDue(now, defaultStability),
    embedding_id: null,
  });

  const all = await loadSharedEntries(host.stateManager);
  const existingIdx = all.findIndex((e) => e.entry_id === entry.entry_id);

  let merged: SharedKnowledgeEntry;
  if (existingIdx >= 0) {
    const existing = all[existingIdx]!;
    merged = SharedKnowledgeEntrySchema.parse({
      ...existing,
      source_goal_ids: Array.from(new Set([...existing.source_goal_ids, goalId])),
    });
    all[existingIdx] = merged;
  } else {
    merged = shared;
    all.push(merged);
  }

  if (host.vectorIndex) {
    const text = `${entry.question} ${entry.answer} ${entry.tags.join(" ")}`;
    const vectorEntry = await host.vectorIndex.add(entry.entry_id, text, {
      goal_id: goalId,
      tags: entry.tags,
      shared: true,
    });
    merged = SharedKnowledgeEntrySchema.parse({
      ...merged,
      embedding_id: vectorEntry.id,
    });
    const targetIdx = existingIdx >= 0 ? existingIdx : all.length - 1;
    all[targetIdx] = merged;
  }

  await host.stateManager.writeRaw(SHARED_KB_PATH, all);
  await host.projectSharedKnowledge(all);
  return merged;
}

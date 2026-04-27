import { z } from "zod";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import {
  AgentMemoryEntrySchema,
} from "./types/agent-memory.js";
import type { AgentMemoryEntry, AgentMemoryStore, AgentMemoryType } from "./types/agent-memory.js";
import { cosineSimilarity } from "./embedding-client.js";
import type { IEmbeddingClient } from "./embedding-client.js";

export interface AgentMemoryHost {
  llmClient: ILLMClient;
  embeddingClient?: IEmbeddingClient;
  loadAgentMemoryStore(): Promise<AgentMemoryStore>;
  saveAgentMemoryStore(store: AgentMemoryStore): Promise<void>;
}

export async function saveAgentMemoryEntry(
  host: AgentMemoryHost,
  entry: {
    key: string;
    value: string;
    tags?: string[];
    category?: string;
    memory_type?: AgentMemoryType;
  }
): Promise<AgentMemoryEntry> {
  const store = await host.loadAgentMemoryStore();
  const now = new Date().toISOString();
  const existing = store.entries.findIndex((e) => e.key === entry.key);

  let saved: AgentMemoryEntry;
  if (existing >= 0) {
    const prev = store.entries[existing]!;
    saved = AgentMemoryEntrySchema.parse({
      ...prev,
      value: entry.value,
      tags: entry.tags ?? prev.tags,
      category: entry.category ?? prev.category,
      memory_type: entry.memory_type ?? prev.memory_type,
      status: prev.status,
      updated_at: now,
    });
    store.entries[existing] = saved;
  } else {
    saved = AgentMemoryEntrySchema.parse({
      id: crypto.randomUUID(),
      key: entry.key,
      value: entry.value,
      tags: entry.tags ?? [],
      category: entry.category,
      memory_type: entry.memory_type ?? "fact",
      created_at: now,
      updated_at: now,
    });
    store.entries.push(saved);
  }

  await host.saveAgentMemoryStore(store);
  return saved;
}

export async function recallAgentMemoryEntries(
  host: AgentMemoryHost,
  query: string,
  opts?: {
    exact?: boolean;
    category?: string;
    memory_type?: AgentMemoryType;
    limit?: number;
    include_archived?: boolean;
    semantic?: boolean;
  }
): Promise<AgentMemoryEntry[]> {
  const store = await host.loadAgentMemoryStore();
  const { exact = false, category, memory_type, limit = 10, include_archived = false, semantic = false } = opts ?? {};

  const candidates = store.entries.filter((e) => {
    if (!include_archived && e.status === "archived") return false;
    const matchesCategory = category ? e.category === category : true;
    const matchesType = memory_type ? e.memory_type === memory_type : true;
    return matchesCategory && matchesType;
  });

  if (semantic && host.embeddingClient) {
    const texts = candidates.map((e) => {
      const base = `${e.key}: ${e.value}`;
      return e.summary ? `${base} (${e.summary})` : base;
    });
    const queryVec = await host.embeddingClient.embed(query);
    const candidateVecs = await host.embeddingClient.batchEmbed(texts);
    const scored = candidates
      .map((e, i) => ({ entry: e, score: cosineSimilarity(queryVec, candidateVecs[i]!) }))
      .filter((s) => s.score >= 0.3);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.entry);
  }

  const lower = query.toLowerCase();
  const results = candidates.filter((e) => exact
    ? e.key === query
    : e.key.toLowerCase().includes(lower) ||
      e.value.toLowerCase().includes(lower) ||
      e.tags.some((t) => t.toLowerCase().includes(lower))
  );

  results.sort((a, b) => {
    const aIsCompiled = a.status === "compiled" ? 0 : 1;
    const bIsCompiled = b.status === "compiled" ? 0 : 1;
    if (aIsCompiled !== bIsCompiled) return aIsCompiled - bIsCompiled;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });
  return results.slice(0, limit);
}

export async function listAgentMemoryEntries(
  host: AgentMemoryHost,
  opts?: {
    category?: string;
    memory_type?: AgentMemoryType;
    limit?: number;
    include_archived?: boolean;
  }
): Promise<AgentMemoryEntry[]> {
  const store = await host.loadAgentMemoryStore();
  const { category, memory_type, limit = 10, include_archived = false } = opts ?? {};

  const results = store.entries.filter((e) => {
    if (!include_archived && e.status === "archived") return false;
    const matchesCategory = category ? e.category === category : true;
    const matchesType = memory_type ? e.memory_type === memory_type : true;
    return matchesCategory && matchesType;
  });

  results.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  return results.slice(0, limit);
}

export async function deleteAgentMemoryEntry(host: AgentMemoryHost, key: string): Promise<boolean> {
  const store = await host.loadAgentMemoryStore();
  const idx = store.entries.findIndex((e) => e.key === key);
  if (idx < 0) return false;
  store.entries.splice(idx, 1);
  await host.saveAgentMemoryStore(store);
  return true;
}

export async function consolidateAgentMemoryEntries(
  host: AgentMemoryHost,
  opts: {
    category?: string;
    memory_type?: AgentMemoryType;
    max_entries?: number;
    llmCall: (prompt: string) => Promise<string>;
  }
): Promise<{ compiled: AgentMemoryEntry[]; archived: number }> {
  const store = await host.loadAgentMemoryStore();
  const now = new Date().toISOString();
  const maxEntries = opts.max_entries ?? 50;

  let rawEntries = store.entries.filter((e) => e.status === "raw");
  if (opts.category) rawEntries = rawEntries.filter((e) => e.category === opts.category);
  if (opts.memory_type) rawEntries = rawEntries.filter((e) => e.memory_type === opts.memory_type);
  rawEntries = rawEntries.slice(0, maxEntries);

  const groups = new Map<string, AgentMemoryEntry[]>();
  for (const entry of rawEntries) {
    const groupKey = `${entry.category ?? "_"}::${entry.memory_type}`;
    const group = groups.get(groupKey) ?? [];
    group.push(entry);
    groups.set(groupKey, group);
  }

  const compiledSchema = z.object({
    key: z.string(),
    value: z.string(),
    summary: z.string(),
    tags: z.array(z.string()),
  });

  const compiled: AgentMemoryEntry[] = [];
  const archivedIds = new Set<string>();

  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const entryLines = group.map((e) => `- [${e.key}]: ${e.value} (tags: ${e.tags.join(", ")})`).join("\n");
    const prompt = [
      "Consolidate the following memory entries into a single entry.",
      "Return ONLY a JSON object with these fields:",
      "- key: a descriptive key for the consolidated memory",
      "- value: the consolidated content (comprehensive but concise)",
      "- summary: a one-line summary (under 100 chars)",
      "- tags: relevant tags as string array",
      "",
      "Entries to consolidate:",
      entryLines,
    ].join("\n");

    let llmRaw: string;
    try {
      llmRaw = await opts.llmCall(prompt);
    } catch {
      continue;
    }

    let cleaned = llmRaw.trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) continue;
    cleaned = jsonMatch[0];

    let parsedResult: z.infer<typeof compiledSchema>;
    try {
      parsedResult = compiledSchema.parse(JSON.parse(cleaned));
    } catch {
      continue;
    }

    const firstEntry = group[0]!;
    const newEntry = AgentMemoryEntrySchema.parse({
      id: crypto.randomUUID(),
      key: parsedResult.key,
      value: parsedResult.value,
      summary: parsedResult.summary,
      tags: parsedResult.tags,
      category: firstEntry.category,
      memory_type: firstEntry.memory_type,
      status: "compiled",
      compiled_from: group.map((e) => e.id),
      created_at: now,
      updated_at: now,
    });

    compiled.push(newEntry);
    store.entries.push(newEntry);
    for (const src of group) archivedIds.add(src.id);
  }

  for (const entry of store.entries) {
    if (archivedIds.has(entry.id)) {
      entry.status = "archived";
      entry.updated_at = now;
    }
  }

  if (compiled.length > 0) {
    store.last_consolidated_at = now;
    await host.saveAgentMemoryStore(store);
  }

  return { compiled, archived: archivedIds.size };
}

export async function archiveAgentMemoryEntries(host: AgentMemoryHost, ids: string[]): Promise<number> {
  const store = await host.loadAgentMemoryStore();
  const now = new Date().toISOString();
  let count = 0;
  const idSet = new Set(ids);

  for (const entry of store.entries) {
    if (idSet.has(entry.id) && entry.status !== "archived") {
      entry.status = "archived";
      entry.updated_at = now;
      count++;
    }
  }

  if (count > 0) {
    await host.saveAgentMemoryStore(store);
  }
  return count;
}

export async function getAgentMemoryStatsForHost(host: AgentMemoryHost): Promise<{
  raw: number;
  compiled: number;
  archived: number;
  total: number;
}> {
  const store = await host.loadAgentMemoryStore();
  const stats = { raw: 0, compiled: 0, archived: 0, total: store.entries.length };
  for (const e of store.entries) {
    if (e.status === "raw") stats.raw++;
    else if (e.status === "compiled") stats.compiled++;
    else if (e.status === "archived") stats.archived++;
  }
  return stats;
}

export async function autoConsolidateAgentMemory(
  host: AgentMemoryHost,
  opts?: { rawThreshold?: number }
): Promise<{ consolidated: boolean; compiled?: number; archived?: number }> {
  try {
    const stats = await getAgentMemoryStatsForHost(host);
    if (stats.raw < (opts?.rawThreshold ?? 20)) {
      return { consolidated: false };
    }
    const llmCall = (prompt: string) =>
      host.llmClient.sendMessage([{ role: "user", content: prompt }]).then((r) => r.content);
    const result = await consolidateAgentMemoryEntries(host, { llmCall });
    return { consolidated: true, compiled: result.compiled.length, archived: result.archived };
  } catch {
    return { consolidated: false };
  }
}

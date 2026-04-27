import * as path from "node:path";
import type { StateManager } from "../../base/state/state-manager.js";
import type { DomainKnowledge, SharedKnowledgeEntry } from "../../base/types/knowledge.js";
import {
  projectAgentMemoryToSoil,
  projectDomainKnowledgeToSoil,
  projectSharedKnowledgeToSoil,
  rebuildSoilIndex,
} from "../soil/index.js";
import {
  AgentMemoryStoreSchema,
  type AgentMemoryStore,
} from "./types/agent-memory.js";

export const AGENT_MEMORY_PATH = "memory/agent-memory/entries.json";
export const SHARED_KB_PATH = "memory/shared-knowledge/entries.json";

export async function loadAgentMemoryStore(stateManager: StateManager): Promise<AgentMemoryStore> {
  const raw = await stateManager.readRaw(AGENT_MEMORY_PATH);
  if (!raw) {
    return AgentMemoryStoreSchema.parse({ entries: [], last_consolidated_at: null });
  }
  return AgentMemoryStoreSchema.parse(raw);
}

export async function projectDomainKnowledge(stateManager: StateManager, goalId: string, domainKnowledge: DomainKnowledge): Promise<void> {
  try {
    const baseDir = stateManager.getBaseDir();
    await projectDomainKnowledgeToSoil({ baseDir, goalId, domainKnowledge });
    await rebuildSoilIndex({ rootDir: path.join(baseDir, "soil") });
  } catch (error) {
    console.warn(
      `[soil] Failed to project domain knowledge for ${goalId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function projectSharedKnowledge(stateManager: StateManager, entries: SharedKnowledgeEntry[]): Promise<void> {
  try {
    const baseDir = stateManager.getBaseDir();
    await projectSharedKnowledgeToSoil({ baseDir, entries });
    await rebuildSoilIndex({ rootDir: path.join(baseDir, "soil") });
  } catch (error) {
    console.warn(
      `[soil] Failed to project shared knowledge: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function projectAgentMemory(stateManager: StateManager, store: AgentMemoryStore): Promise<void> {
  try {
    const baseDir = stateManager.getBaseDir();
    await projectAgentMemoryToSoil({ baseDir, store });
    await rebuildSoilIndex({ rootDir: path.join(baseDir, "soil") });
  } catch (error) {
    console.warn(
      `[soil] Failed to project agent memory: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

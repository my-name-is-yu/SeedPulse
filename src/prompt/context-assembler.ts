/**
 * context-assembler.ts
 * Assembles context from hierarchical memory layers into XML-tagged blocks for LLM prompts.
 */

import {
  getSlotConfig,
  getSlotDefinition,
  type ContextPurpose,
  type ContextSlot,
  type SlotDefinition,
  type BudgetCategory,
} from "./slot-definitions.js";
import {
  wrapXmlTag,
  estimateTokens,
  trimToTokenBudget,
  formatGoalContext,
  formatCurrentState,
  formatObservationHistory,
  formatLessons,
  formatKnowledge,
  formatReflections,
  formatWorkspaceState,
  formatStrategyTemplates,
  formatFailureContext,
  formatTaskResults,
} from "./formatters.js";
import { allocateBudget, type BudgetAllocation } from "../execution/context-budget.js";
import type { Dimension } from "../types/goal.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Lessons older than this many days AND with low access_count are considered stale. */
const CONTEXT_FRESHNESS_DAYS = 14;

/** Minimum cosine similarity threshold for vector knowledge search. */
const KNOWLEDGE_SIMILARITY_THRESHOLD = 0.6;

/** Strategy templates older than this many days are deprioritized when no vector search is available. */
const STRATEGY_TEMPLATE_FRESHNESS_DAYS = 30;

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface AssembledContext {
  systemPrompt: string;
  contextBlock: string;
  totalTokensUsed: number;
}

export interface ContextAssemblerDeps {
  stateManager?: {
    loadGoalState(goalId: string): Promise<any | null>;
  };
  memoryLifecycle?: {
    selectForWorkingMemory(
      goalId: string,
      dims: string[],
      tags: string[],
      max?: number
    ): Promise<{ shortTerm: any[]; lessons: any[] }>;
    selectForWorkingMemorySemantic?(
      goalId: string,
      query: string,
      dims: string[],
      tags: string[],
      max?: number
    ): Promise<{ shortTerm: any[]; lessons: any[] }>;
  };
  knowledgeManager?: {
    getRelevantKnowledge?(goalId: string): Promise<any[]>;
    loadKnowledge?(goalId: string, tags?: string[]): Promise<any[]>;
  };
  contextProvider?: {
    buildWorkspaceContextItems?(
      goalId: string,
      dimensionName: string
    ): Promise<Array<{ label: string; content: string }>>;
  };
  reflectionGetter?: (goalId: string, limit?: number) => Promise<any[]>;
  strategyTemplateSearch?: (query: string, topK?: number) => Promise<any[]>;
  vectorIndex?: {
    search(
      query: string,
      topK?: number,
      threshold?: number
    ): Promise<Array<{ id: string; text: string; similarity: number; metadata?: Record<string, unknown> }>>;
  };
  budgetTokens?: number;
  budgetAllocator?: (totalBudget: number) => BudgetAllocation;
}

// ─── Slot → BudgetCategory mapping ───────────────────────────────────────────

const SLOT_CATEGORY_MAP: Record<ContextSlot, BudgetCategory> = {
  goal_definition:     "goalDefinition",
  current_state:       "goalDefinition",
  dimension_history:   "observations",
  recent_task_results: "observations",
  reflections:         "observations",
  workspace_state:     "observations",
  failure_context:     "observations",
  lessons:             "knowledge",
  knowledge:           "knowledge",
  strategy_templates:  "transferKnowledge",
};

// ─── Default system prompt ────────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT =
  "You are an AI assistant helping to achieve a goal. Use the context provided to give accurate, focused responses.";

// ─── ContextAssembler ─────────────────────────────────────────────────────────

export class ContextAssembler {
  private readonly deps: ContextAssemblerDeps;
  private readonly budget: number;

  constructor(deps: ContextAssemblerDeps = {}) {
    this.deps = deps;
    this.budget = deps.budgetTokens ?? 4000;
  }

  async build(
    purpose: ContextPurpose,
    goalId: string | undefined,
    dimensionName?: string,
    additionalContext?: Record<string, string>
  ): Promise<AssembledContext> {
    const slotConfig = getSlotConfig(purpose);
    const goalState = goalId ? await this.loadGoalState(goalId) : null;
    const dims = this.extractDimensionNames(goalState, dimensionName);

    // Compute per-category token budgets
    const allocator = this.deps.budgetAllocator ?? allocateBudget;
    const baseAllocation = allocator(this.budget);
    const categoryBudgets = this.applyBudgetOverrides(baseAllocation, slotConfig.budgetOverrides);

    // Assemble each active slot
    const assembled: Array<{ slotDef: SlotDefinition; xmlBlock: string; tokens: number; category: BudgetCategory }> = [];

    for (const slot of slotConfig.activeSlots) {
      const slotDef = getSlotDefinition(slot);
      const content = await this.assembleSlot(slot, goalId, goalState, dims, additionalContext);
      if (!content) continue;

      const xmlBlock = wrapXmlTag(slotDef.xmlTag, content);
      if (!xmlBlock) continue;

      const category = SLOT_CATEGORY_MAP[slot];
      assembled.push({ slotDef, xmlBlock, tokens: estimateTokens(xmlBlock), category });
    }

    // Enforce budget: respect per-category limits, then global total
    const trimmed = this.enforceBudget(assembled, this.budget, categoryBudgets);

    const contextBlock = trimmed.map((e) => e.xmlBlock).join("\n\n");
    const totalTokensUsed = estimateTokens(contextBlock);

    return {
      systemPrompt: "",
      contextBlock,
      totalTokensUsed,
    };
  }

  // ─── Budget helpers ──────────────────────────────────────────────────────────

  private applyBudgetOverrides(
    base: BudgetAllocation,
    overrides?: Partial<Record<BudgetCategory, number>>
  ): BudgetAllocation {
    if (!overrides) return base;

    // Overrides are percentages; convert to absolute tokens
    const result = { ...base };
    for (const [cat, pct] of Object.entries(overrides) as [keyof BudgetAllocation, number][]) {
      result[cat] = Math.floor(this.budget * (pct / 100));
    }
    return result;
  }

  // ─── Slot assemblers ────────────────────────────────────────────────────────

  private async assembleSlot(
    slot: ContextSlot,
    goalId: string | undefined,
    goalState: any,
    dims: string[],
    additionalContext?: Record<string, string>
  ): Promise<string> {
    try {
      switch (slot) {
        case "goal_definition":
          return this.buildGoalDefinition(goalState);

        case "current_state":
          return this.buildCurrentState(goalState);

        case "dimension_history":
          return this.buildDimensionHistory(goalState);

        case "recent_task_results":
          return this.buildRecentTaskResults(additionalContext);

        case "reflections":
          if (!goalId) return "";
          return await this.buildReflections(goalId);

        case "lessons":
          if (!goalId) return "";
          return await this.buildLessons(goalId, dims);

        case "knowledge":
          if (!goalId) return "";
          return await this.buildKnowledge(goalId);

        case "strategy_templates":
          return await this.buildStrategyTemplates(goalState);

        case "workspace_state":
          if (!goalId) return "";
          return await this.buildWorkspaceState(goalId, dims[0]);

        case "failure_context":
          return this.buildFailureContext(additionalContext);

        default:
          return "";
      }
    } catch {
      return "";
    }
  }

  // ─── Individual slot builders ────────────────────────────────────────────────

  private buildGoalDefinition(goalState: any): string {
    if (!goalState) return "";
    return formatGoalContext(
      { title: goalState.title, description: goalState.description },
      goalState.active_strategy
    );
  }

  private buildCurrentState(goalState: any): string {
    if (!goalState?.dimensions?.length) return "";
    const dims = ((goalState.dimensions as Dimension[]) ?? []).map((d: Dimension) => ({
      name: d.name,
      current: d.current_value,
      target: d.threshold?.value,
      gap: d.gap,
    }));
    return formatCurrentState(dims);
  }

  private buildDimensionHistory(goalState: any): string {
    if (!goalState?.dimensions?.length) return "";

    const allHistory: Array<{ timestamp: string; score: number }> = [];
    for (const dim of ((goalState.dimensions as Dimension[]) ?? [])) {
      if (dim.history?.length) {
        for (const h of dim.history) {
          allHistory.push({ timestamp: h.timestamp, score: h.value });
        }
      }
    }
    return formatObservationHistory(allHistory);
  }

  private buildRecentTaskResults(additionalContext?: Record<string, string>): string {
    const raw = additionalContext?.["existingTasks"] ?? additionalContext?.["recentTaskResults"];
    if (!raw) return "";

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return formatTaskResults(parsed);
      }
    } catch {
      // raw is not JSON — return it as-is
      return raw;
    }
    return "";
  }

  private async buildReflections(goalId: string): Promise<string> {
    if (!this.deps.reflectionGetter) return "";
    const reflections = await this.deps.reflectionGetter(goalId, 5);
    if (!reflections?.length) return "";
    return formatReflections(
      reflections.map((r: any) => ({
        what_failed: r.why_it_worked_or_failed,
        suggestion: r.what_to_do_differently,
        content: r.what_was_attempted,
      }))
    );
  }

  private async buildLessons(goalId: string, dims: string[]): Promise<string> {
    if (!this.deps.memoryLifecycle) return "";
    const result = await this.deps.memoryLifecycle.selectForWorkingMemory(goalId, dims, []);
    if (!result?.lessons?.length) return "";

    let lessons = result.lessons;

    // Apply stale filtering only when we have more entries than needed
    const budgetedMax = 5; // default lesson slot max
    if (lessons.length > budgetedMax) {
      const cutoffMs = CONTEXT_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const fresh = lessons.filter((l: any) => {
        const lastAccessed = l.last_accessed ? new Date(l.last_accessed).getTime() : 0;
        const accessCount = l.access_count ?? 0;
        const isStale = (now - lastAccessed) > cutoffMs && accessCount < 2;
        return !isStale;
      });
      // Only apply filter if it doesn't eliminate everything
      if (fresh.length > 0) {
        lessons = fresh;
      }
    }

    return formatLessons(
      lessons.map((l: any) => ({
        importance: l.relevance_tags?.includes("HIGH")
          ? "HIGH"
          : l.relevance_tags?.includes("LOW")
          ? "LOW"
          : "MEDIUM",
        content: l.lesson ?? l.content ?? "",
      }))
    );
  }

  private async buildKnowledge(goalId: string): Promise<string> {
    if (!this.deps.knowledgeManager && !this.deps.vectorIndex) return "";

    let entries: any[] = [];

    if (this.deps.knowledgeManager?.getRelevantKnowledge) {
      entries = await this.deps.knowledgeManager.getRelevantKnowledge(goalId);
    } else if (this.deps.knowledgeManager?.loadKnowledge) {
      entries = await this.deps.knowledgeManager.loadKnowledge(goalId);
    } else if (this.deps.vectorIndex) {
      const results = await this.deps.vectorIndex.search(goalId, 5, KNOWLEDGE_SIMILARITY_THRESHOLD);
      entries = results.map((r) => ({ content: r.text, confidence: r.similarity }));
    }

    if (!entries?.length) return "";
    return formatKnowledge(entries);
  }

  private async buildStrategyTemplates(goalState: any): Promise<string> {
    if (!this.deps.strategyTemplateSearch) return "";
    const query = goalState?.active_strategy?.hypothesis ?? goalState?.title ?? "";
    if (!query) return "";
    let templates = await this.deps.strategyTemplateSearch(query, 3);
    if (!templates?.length) return "";

    if (this.deps.vectorIndex) {
      // Vector search: apply cosine similarity threshold
      templates = templates.filter((t: any) => {
        const sim = t.similarity ?? t.score ?? 1;
        return sim >= KNOWLEDGE_SIMILARITY_THRESHOLD;
      });
    } else {
      // No vector search: deprioritize templates older than 30 days
      const cutoffMs = STRATEGY_TEMPLATE_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const fresh = templates.filter((t: any) => {
        const created = t.created_at ?? t.createdAt;
        if (!created) return true; // no date means keep
        return (now - new Date(created).getTime()) <= cutoffMs;
      });
      // Use fresh templates if any exist; otherwise fall back to all templates
      if (fresh.length > 0) {
        templates = fresh;
      }
    }

    if (!templates?.length) return "";
    return formatStrategyTemplates(templates);
  }

  private async buildWorkspaceState(goalId: string, dimensionName?: string): Promise<string> {
    if (!this.deps.contextProvider?.buildWorkspaceContextItems) return "";
    const dim = dimensionName ?? "";
    const items = await this.deps.contextProvider.buildWorkspaceContextItems(goalId, dim);
    if (!items?.length) return "";
    return formatWorkspaceState(items.map((i) => `${i.label}: ${i.content}`));
  }

  private buildFailureContext(additionalContext?: Record<string, string>): string {
    const raw = additionalContext?.["failureContext"] ?? additionalContext?.["failure_context"];
    if (!raw) return "";
    return formatFailureContext(raw);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async loadGoalState(goalId: string | undefined): Promise<any | null> {
    if (!goalId || !this.deps.stateManager) return null;
    try {
      return await this.deps.stateManager.loadGoalState(goalId);
    } catch {
      return null;
    }
  }

  private extractDimensionNames(goalState: any, dimensionName?: string): string[] {
    if (dimensionName) return [dimensionName];
    if (!goalState?.dimensions?.length) return [];
    return ((goalState.dimensions as Dimension[]) ?? []).map((d: Dimension) => d.name);
  }

  private enforceBudget(
    assembled: Array<{ slotDef: SlotDefinition; xmlBlock: string; tokens: number; category: BudgetCategory }>,
    budget: number,
    categoryBudgets?: BudgetAllocation
  ): Array<{ slotDef: SlotDefinition; xmlBlock: string; tokens: number; category: BudgetCategory }> {
    // Apply per-category limits first when provided
    let capped = assembled;
    if (categoryBudgets) {
      const categoryUsed: Partial<Record<BudgetCategory, number>> = {};
      capped = assembled.map((entry) => {
        const cat = entry.category;
        const catLimit = categoryBudgets[cat];
        const used = categoryUsed[cat] ?? 0;
        const remaining = catLimit - used;

        if (remaining <= 0) return null;

        if (entry.tokens <= remaining) {
          categoryUsed[cat] = used + entry.tokens;
          return entry;
        }

        // Trim to fit within remaining category budget
        const trimmedBlock = trimToTokenBudget(entry.xmlBlock, remaining);
        const trimmedTokens = estimateTokens(trimmedBlock);
        categoryUsed[cat] = used + trimmedTokens;
        return { ...entry, xmlBlock: trimmedBlock, tokens: trimmedTokens };
      }).filter((e): e is NonNullable<typeof e> => e !== null);
    }

    const total = capped.reduce((sum, e) => sum + e.tokens, 0);
    if (total <= budget) return capped;

    // Sort by priority ascending (lower priority number = more important)
    const sorted = [...capped].sort((a, b) => a.slotDef.priority - b.slotDef.priority);

    // Trim from lowest priority (highest number) first
    let remaining = budget;
    const result: typeof sorted = [];

    for (const entry of sorted) {
      if (remaining <= 0) break;
      if (entry.tokens <= remaining) {
        result.push(entry);
        remaining -= entry.tokens;
      } else {
        // Partially trim this entry
        const trimmedBlock = trimToTokenBudget(entry.xmlBlock, remaining);
        const trimmedTokens = estimateTokens(trimmedBlock);
        result.push({ ...entry, xmlBlock: trimmedBlock, tokens: trimmedTokens });
        remaining = 0;
      }
    }

    // Restore original slot order (by priority ascending = natural order)
    return result.sort((a, b) => a.slotDef.priority - b.slotDef.priority);
  }
}

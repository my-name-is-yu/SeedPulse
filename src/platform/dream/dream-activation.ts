import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { KnowledgeEntry } from "../knowledge/types/knowledge.js";
import { KnowledgeEntrySchema } from "../knowledge/types/knowledge.js";
import type { LearnedPattern } from "../knowledge/types/learning.js";
import { LearnedPatternSchema } from "../knowledge/types/learning.js";
import type { StrategyTemplate } from "../../orchestrator/strategy/types/cross-portfolio.js";
import { StrategyTemplateSchema } from "../../orchestrator/strategy/types/cross-portfolio.js";
import type { Strategy } from "../../orchestrator/strategy/types/strategy.js";
import { loadDreamConfig } from "./dream-config.js";

export interface DreamActivationRuntimeState {
  flags: Awaited<ReturnType<typeof loadDreamConfig>>["activation"];
}

export const DreamDecisionHeuristicSchema = z.object({
  id: z.string(),
  if_stall_count_gte: z.number().int().nonnegative().optional(),
  strategy_id: z.string().optional(),
  strategy_hypothesis_includes: z.string().optional(),
  prefer_strategy_hypothesis_includes: z.string().optional(),
  avoid_strategy_hypothesis_includes: z.string().optional(),
  score_delta: z.number().default(0),
  reason: z.string().default("dream heuristic"),
});

export type DreamDecisionHeuristic = z.infer<typeof DreamDecisionHeuristicSchema>;

const DreamDecisionHeuristicFileSchema = z.object({
  heuristics: z.array(DreamDecisionHeuristicSchema).default([]),
});

function scoreTextOverlap(query: string, candidate: string): number {
  const queryTokens = new Set(
    query.toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token.length >= 3)
  );
  const candidateTokens = new Set(
    candidate.toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token.length >= 3)
  );
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;

  let hits = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) hits += 1;
  }
  return hits / Math.max(queryTokens.size, candidateTokens.size);
}

export async function loadDreamActivationState(baseDir: string): Promise<DreamActivationRuntimeState> {
  const config = await loadDreamConfig(baseDir);
  return { flags: config.activation };
}

export async function loadStrategyTemplates(baseDir: string): Promise<StrategyTemplate[]> {
  const filePath = path.join(baseDir, "strategy-templates.json");
  try {
    const raw = JSON.parse(await fsp.readFile(filePath, "utf8")) as unknown;
    return z.array(StrategyTemplateSchema).parse(raw);
  } catch {
    return [];
  }
}

export async function loadDecisionHeuristics(baseDir: string): Promise<DreamDecisionHeuristic[]> {
  const filePath = path.join(baseDir, "dream", "decision-heuristics.json");
  try {
    const raw = JSON.parse(await fsp.readFile(filePath, "utf8")) as unknown;
    return DreamDecisionHeuristicFileSchema.parse(raw).heuristics;
  } catch {
    return [];
  }
}

export async function loadLearnedPatterns(baseDir: string, goalId?: string): Promise<LearnedPattern[]> {
  const learningDir = path.join(baseDir, "learning");
  const files = await fsp.readdir(learningDir).catch(() => [] as string[]);
  const targetFiles = goalId
    ? files.filter((file) => file === `${goalId}_patterns.json`)
    : files.filter((file) => file.endsWith("_patterns.json"));

  const patterns: LearnedPattern[] = [];
  for (const file of targetFiles) {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(learningDir, file), "utf8")) as unknown;
      const parsed = z.array(LearnedPatternSchema).safeParse(raw);
      if (parsed.success) {
        patterns.push(...parsed.data);
      }
    } catch {
      // Ignore malformed pattern files.
    }
  }
  return patterns;
}

export function selectPatternHints(
  patterns: LearnedPattern[],
  query: string,
  limit = 3
): LearnedPattern[] {
  return [...patterns]
    .map((pattern) => ({
      pattern,
      score:
        pattern.confidence * 0.7 +
        Math.min(pattern.evidence_count, 5) * 0.03 +
        scoreTextOverlap(query, `${pattern.description} ${pattern.applicable_domains.join(" ")}`) * 0.5,
    }))
    .filter(({ score }) => score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ pattern }) => pattern);
}

export function formatPatternHints(patterns: LearnedPattern[]): string {
  if (patterns.length === 0) return "";
  return [
    "Learned pattern hints:",
    ...patterns.map(
      (pattern, index) =>
        `${index + 1}. [${pattern.type}] ${pattern.description} (confidence ${pattern.confidence.toFixed(2)})`
    ),
  ].join("\n");
}

export function selectTemplateCandidates(
  templates: StrategyTemplate[],
  query: string,
  targetDimensions: string[],
  limit = 1
): StrategyTemplate[] {
  const dimensionSet = new Set(targetDimensions.map((dimension) => dimension.toLowerCase()));
  return [...templates]
    .map((template) => {
      const dimensionOverlap = template.applicable_dimensions.filter((dimension) =>
        dimensionSet.has(dimension.toLowerCase())
      ).length;
      const score =
        template.effectiveness_score * 0.6 +
        scoreTextOverlap(query, `${template.hypothesis_pattern} ${template.domain_tags.join(" ")}`) * 0.4 +
        Math.min(dimensionOverlap, 2) * 0.1;
      return { template, score };
    })
    .filter(({ score }) => score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ template }) => template);
}

export function materializeTemplateCandidate(
  template: StrategyTemplate,
  goalId: string,
  primaryDimension: string,
  targetDimensions: string[]
): Strategy {
  const now = new Date().toISOString();
  return {
    id: `dream-template-${template.template_id}-${randomUUID()}`,
    goal_id: goalId,
    primary_dimension: primaryDimension,
    target_dimensions: targetDimensions.length > 0 ? targetDimensions : template.applicable_dimensions,
    hypothesis: template.hypothesis_pattern,
    expected_effect: (targetDimensions.length > 0 ? targetDimensions : template.applicable_dimensions).map((dimension) => ({
      dimension,
      direction: "increase" as const,
      magnitude: "medium" as const,
    })),
    resource_estimate: {
      sessions: 1,
      duration: { value: 1, unit: "hours" as const },
      llm_calls: null,
    },
    state: "candidate",
    allocation: 0,
    created_at: now,
    started_at: null,
    completed_at: null,
    gap_snapshot_at_start: null,
    tasks_generated: [],
    effectiveness_score: null,
    consecutive_stall_count: 0,
    source_template_id: template.template_id,
    cross_goal_context: `Dream template from ${template.source_goal_id}`,
    rollback_target_id: null,
    max_pivot_count: 2,
    pivot_count: 0,
    toolset_locked: false,
    allowed_tools: [],
    required_tools: [],
  };
}

export function applyDecisionHeuristicsToCandidates(
  candidates: Strategy[],
  heuristics: DreamDecisionHeuristic[],
  context: {
    stallCount: number;
    activeStrategyId?: string | null;
  }
): Strategy[] {
  if (heuristics.length === 0 || candidates.length <= 1) return candidates;

  const scored = candidates.map((candidate, index) => {
    let score = 0;
    for (const heuristic of heuristics) {
      if (
        heuristic.if_stall_count_gte !== undefined &&
        context.stallCount < heuristic.if_stall_count_gte
      ) {
        continue;
      }
      if (heuristic.strategy_id && heuristic.strategy_id !== context.activeStrategyId) {
        continue;
      }
      if (
        heuristic.strategy_hypothesis_includes &&
        !candidate.hypothesis.toLowerCase().includes(heuristic.strategy_hypothesis_includes.toLowerCase())
      ) {
        continue;
      }
      if (
        heuristic.prefer_strategy_hypothesis_includes &&
        candidate.hypothesis.toLowerCase().includes(heuristic.prefer_strategy_hypothesis_includes.toLowerCase())
      ) {
        score += Math.abs(heuristic.score_delta || 0.15);
        continue;
      }
      if (
        heuristic.avoid_strategy_hypothesis_includes &&
        candidate.hypothesis.toLowerCase().includes(heuristic.avoid_strategy_hypothesis_includes.toLowerCase())
      ) {
        score -= Math.abs(heuristic.score_delta || 0.15);
        continue;
      }
      score += heuristic.score_delta;
    }
    return { candidate, score, index };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map(({ candidate }) => candidate);
}

export function mergeUniqueKnowledgeEntries(
  primary: KnowledgeEntry[],
  secondary: KnowledgeEntry[],
  limit?: number
): KnowledgeEntry[] {
  const merged: KnowledgeEntry[] = [];
  const seen = new Set<string>();

  for (const entry of [...primary, ...secondary]) {
    if (seen.has(entry.entry_id)) continue;
    seen.add(entry.entry_id);
    merged.push(KnowledgeEntrySchema.parse(entry));
    if (limit !== undefined && merged.length >= limit) break;
  }

  return merged;
}

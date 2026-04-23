import type {
  GroundingBundle,
  GroundingGatewayDeps,
  GroundingProvider,
  GroundingRequest,
  GroundingSection,
} from "./contracts.js";
import { resolveGroundingProfile } from "./profiles.js";
import { renderDebugBundle } from "./renderers/debug-renderer.js";
import { renderPromptBundle } from "./renderers/prompt-renderer.js";
import { approvalPolicyProvider, executionPolicyProvider, identityProvider } from "./providers/static-policy-provider.js";
import { providerStateProvider } from "./providers/provider-state-provider.js";
import { pluginsProvider } from "./providers/plugins-provider.js";
import { goalStateProvider } from "./providers/goal-state-provider.js";
import { taskStateProvider } from "./providers/task-state-provider.js";
import { trustStateProvider } from "./providers/trust-state-provider.js";
import { sessionHistoryProvider } from "./providers/session-history-provider.js";
import { progressHistoryProvider } from "./providers/progress-history-provider.js";
import { soilKnowledgeProvider } from "./providers/soil-provider.js";
import { knowledgeQueryProvider } from "./providers/knowledge-provider.js";
import { lessonsProvider } from "./providers/lessons-provider.js";
import { repoInstructionsProvider } from "./providers/agents-provider.js";
import { workspaceFactsProvider } from "./providers/workspace-facts-provider.js";
import { sortSections } from "./providers/helpers.js";

const PROVIDERS: GroundingProvider[] = [
  identityProvider,
  executionPolicyProvider,
  approvalPolicyProvider,
  trustStateProvider,
  repoInstructionsProvider,
  goalStateProvider,
  taskStateProvider,
  progressHistoryProvider,
  sessionHistoryProvider,
  soilKnowledgeProvider,
  knowledgeQueryProvider,
  lessonsProvider,
  providerStateProvider,
  pluginsProvider,
  workspaceFactsProvider,
];

export interface GroundingGateway {
  build(request: GroundingRequest): Promise<GroundingBundle>;
}

function cloneSections(sections: GroundingSection[]): GroundingSection[] {
  return sections.map((section) => ({ ...section, sources: section.sources.map((source) => ({ ...source })) }));
}

function truncateSectionContent(content: string, maxTokens: number): string {
  if (maxTokens <= 0) {
    return "";
  }
  const maxChars = Math.max(1, maxTokens * 4 - 3);
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars)}...`;
}

function enforceTokenBudget(
  sections: GroundingSection[],
  maxTokens: number,
  warnings: string[],
): GroundingSection[] {
  let remaining = maxTokens;
  const bounded: GroundingSection[] = [];

  for (const section of sections) {
    if (remaining <= 0) {
      warnings.push(`Dropped ${section.key} because the grounding profile budget of ${maxTokens} tokens was exhausted.`);
      continue;
    }

    if (section.estimatedTokens <= remaining) {
      bounded.push(section);
      remaining -= section.estimatedTokens;
      continue;
    }

    const content = truncateSectionContent(section.content, remaining);
    const estimatedTokens = Math.max(1, Math.ceil(content.length / 4));
    bounded.push({
      ...section,
      content,
      estimatedTokens,
    });
    warnings.push(`Truncated ${section.key} to fit the grounding profile budget of ${maxTokens} tokens.`);
    remaining -= estimatedTokens;
  }

  return bounded;
}

export class DefaultGroundingGateway implements GroundingGateway {
  private readonly staticCache = new Map<string, GroundingSection[]>();

  constructor(private readonly deps: GroundingGatewayDeps = {}) {}

  async build(request: GroundingRequest): Promise<GroundingBundle> {
    const started = Date.now();
    const profile = resolveGroundingProfile(request);
    const warnings: string[] = [];
    const runtime = new Map<string, unknown>();
    let cacheHits = 0;

    const staticCacheKey = JSON.stringify({
      profile: profile.id,
      include: {
        identity: profile.include.identity,
        execution_policy: profile.include.execution_policy,
        approval_policy: profile.include.approval_policy,
      },
    });

    let staticSections = this.staticCache.get(staticCacheKey);
    if (staticSections) {
      cacheHits += 1;
      staticSections = cloneSections(staticSections);
    } else {
      const context = { deps: this.deps, profile, request, warnings, runtime };
      staticSections = [];
      for (const provider of PROVIDERS.filter((candidate) => candidate.kind === "static")) {
        if (!profile.include[provider.key]) continue;
        const section = await provider.build(context);
        if (section) staticSections.push(section);
      }
      this.staticCache.set(staticCacheKey, cloneSections(staticSections));
    }

    const context = { deps: this.deps, profile, request, warnings, runtime };
    const dynamicSections: GroundingSection[] = [];
    for (const provider of PROVIDERS.filter((candidate) => candidate.kind === "dynamic")) {
      if (!profile.include[provider.key]) continue;
      const section = await provider.build(context);
      if (section) {
        dynamicSections.push(section);
      }
    }

    const orderedStatic = sortSections(staticSections);
    const orderedDynamic = sortSections(dynamicSections);
    const boundedSections = enforceTokenBudget([...orderedStatic, ...orderedDynamic], profile.budgets.maxTokens, warnings);
    const dynamicKeys = new Set(orderedDynamic.map((section) => section.key));
    const boundedStatic = boundedSections.filter((section) => !dynamicKeys.has(section.key));
    const boundedDynamic = boundedSections.filter((section) => dynamicKeys.has(section.key));
    const allSections = boundedSections;
    const totalEstimatedTokens = allSections.reduce((sum, section) => sum + section.estimatedTokens, 0);
    const retrievalIds = allSections.flatMap((section) =>
      section.sources
        .map((source) => source.retrievalId)
        .filter((retrievalId): retrievalId is string => typeof retrievalId === "string"),
    );

    const bundle: GroundingBundle = {
      profile: profile.id,
      staticSections: boundedStatic,
      dynamicSections: boundedDynamic,
      warnings,
      metrics: {
        totalEstimatedTokens,
        buildMs: Date.now() - started,
        cacheHits,
      },
      traces: {
        source: allSections.flatMap((section) => section.sources),
        retrievalIds,
      },
      render(format: "prompt" | "debug-json" = "prompt"): string | Record<string, unknown> {
        return format === "debug-json" ? renderDebugBundle(bundle) : renderPromptBundle(bundle);
      },
    };

    return bundle;
  }
}

export function createGroundingGateway(deps: GroundingGatewayDeps = {}): GroundingGateway {
  return new DefaultGroundingGateway(deps);
}

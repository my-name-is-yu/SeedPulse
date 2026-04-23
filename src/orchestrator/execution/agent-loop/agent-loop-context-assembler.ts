import { resolve } from "node:path";
import type { Task } from "../../../base/types/task.js";
import { createGroundingGateway, type GroundingGateway } from "../../../grounding/gateway.js";
import { discoverAgentInstructionCandidates } from "../../../grounding/providers/agents-provider.js";
import type { GroundingSection } from "../../../grounding/contracts.js";

export interface AgentLoopContextBlock {
  id: string;
  source: string;
  content: string;
  priority: number;
}

export interface SoilPrefetchQuery {
  query: string;
  rootDir: string;
  limit: number;
}

export interface SoilPrefetchResult {
  content: string;
  soilIds?: string[];
  retrievalSource?: "index" | "manifest";
  warnings?: string[];
}

export interface TaskAgentLoopAssemblyInput {
  task: Task;
  cwd?: string;
  workspaceContext?: string;
  knowledgeContext?: string;
  soilPrefetch?: (query: SoilPrefetchQuery) => Promise<SoilPrefetchResult | null>;
  maxProjectDocChars?: number;
  trustProjectInstructions?: boolean;
}

export interface TaskAgentLoopAssembly {
  cwd: string;
  systemPrompt: string;
  userPrompt: string;
  contextBlocks: AgentLoopContextBlock[];
}

function sectionToBlock(section: GroundingSection): AgentLoopContextBlock {
  const source = section.sources[0]?.path ?? section.sources[0]?.label ?? section.key;
  const id = section.key === "soil_knowledge" ? "soil-prefetch" : section.key;
  return {
    id,
    source,
    content: section.content,
    priority: section.priority,
  };
}

function renderStaticSections(sections: GroundingSection[]): string {
  return sections
    .map((section) => `## ${section.title}\n${section.content}`.trim())
    .join("\n\n")
    .trim();
}

export class AgentLoopContextAssembler {
  constructor(private readonly groundingGateway: GroundingGateway = createGroundingGateway()) {}

  async assembleTask(input: TaskAgentLoopAssemblyInput): Promise<TaskAgentLoopAssembly> {
    const cwd = resolve(input.cwd ?? process.cwd());
    const soilQuery = input.soilPrefetch
      ? async ({ query, rootDir, limit }: { query: string; rootDir: string; limit: number }) => {
          const soil = await input.soilPrefetch!({ query, rootDir, limit });
          if (!soil?.content.trim()) {
            return null;
          }
          return {
            retrievalSource: (soil.retrievalSource ?? "prefetch") as "prefetch" | "index" | "manifest",
            warnings: soil.warnings ?? [],
            hits: [
              {
                soilId: soil.soilIds?.[0] ?? "soil:prefetch",
                title: "Prefetched Soil context",
                summary: soil.content,
              },
            ],
          };
        }
      : undefined;

    const query = [
      input.task.work_description,
      input.task.approach,
      ...input.task.success_criteria.map((criterion) => criterion.description),
      input.workspaceContext ?? "",
      input.knowledgeContext ?? "",
    ].join("\n");

    const bundle = await this.groundingGateway.build({
      surface: "agent_loop",
      purpose: "task_execution",
      workspaceRoot: cwd,
      goalId: input.task.goal_id,
      taskId: input.task.id,
      query,
      userMessage: input.task.work_description,
      trustProjectInstructions: input.trustProjectInstructions ?? true,
      workspaceContext: input.workspaceContext,
      knowledgeContext: input.knowledgeContext,
      soilQuery,
      include: {
        session_history: false,
        progress_history: false,
        trust_state: false,
        provider_state: false,
        plugins: false,
      },
    });

    const blocks = bundle.dynamicSections.map(sectionToBlock).sort((a, b) => a.priority - b.priority);
    const userPrompt = [
      `Task: ${input.task.work_description}`,
      `Approach: ${input.task.approach}`,
      `Success criteria:\n${input.task.success_criteria.map((c) => `- ${c.description}`).join("\n")}`,
      blocks.length > 0
        ? `Context:\n${blocks.map((block) => `[${block.source}]\n${block.content}`).join("\n\n")}`
        : "",
      "Return final output as JSON matching the required schema.",
    ].filter(Boolean).join("\n\n");

    return {
      cwd,
      systemPrompt: renderStaticSections(bundle.staticSections),
      userPrompt,
      contextBlocks: blocks,
    };
  }
}

export async function loadProjectInstructionBlocks(
  cwd: string,
  maxChars: number,
  options: { trustProjectInstructions?: boolean } = {},
): Promise<AgentLoopContextBlock[]> {
  const candidates = await discoverAgentInstructionCandidates(cwd, maxChars, options);
  return candidates
    .filter((candidate) => candidate.accepted)
    .map((candidate) => ({
      id: `project-doc:${candidate.filePath}`,
      source: candidate.filePath,
      content: candidate.content,
      priority: candidate.priority,
    }));
}

/**
 * gateway.ts
 * Thin orchestrator: assembles context, calls LLM, parses response.
 */

import { z } from "zod";
import type { ILLMClient } from "../llm/llm-client.js";
import { ContextAssembler } from "./context-assembler.js";
import { PURPOSE_CONFIGS } from "./purposes/index.js";
import type { ContextPurpose } from "./slot-definitions.js";

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface PromptGatewayInput<T> {
  purpose: ContextPurpose;
  goalId?: string;
  dimensionName?: string;
  additionalContext?: Record<string, string>;
  responseSchema: z.ZodSchema<T>;
  maxTokens?: number;
  temperature?: number;
}

export interface IPromptGateway {
  execute<T>(input: PromptGatewayInput<T>): Promise<T>;
}

// ─── PromptGateway ────────────────────────────────────────────────────────────

export class PromptGateway implements IPromptGateway {
  constructor(
    private llmClient: ILLMClient,
    private assembler: ContextAssembler,
    private options?: { logger?: (msg: string) => void }
  ) {}

  async execute<T>(input: PromptGatewayInput<T>): Promise<T> {
    const config = PURPOSE_CONFIGS[input.purpose];

    let assembled;
    try {
      assembled = await this.assembler.build(
        input.purpose,
        input.goalId,
        input.dimensionName,
        input.additionalContext
      );
    } catch (err) {
      throw new Error(
        `[PromptGateway] context assembly failed (purpose=${input.purpose}, goalId=${input.goalId ?? "none"}): ${err}`
      );
    }

    let response;
    try {
      response = await this.llmClient.sendMessage(
        [{ role: "user", content: assembled.contextBlock }],
        {
          system: assembled.systemPrompt || config.systemPrompt,
          max_tokens: input.maxTokens ?? config.defaultMaxTokens,
          temperature: input.temperature ?? config.defaultTemperature,
        }
      );
    } catch (err) {
      throw new Error(
        `[PromptGateway] LLM call failed (purpose=${input.purpose}, goalId=${input.goalId ?? "none"}): ${err}`
      );
    }

    const parsed = this.llmClient.parseJSON(response.content, input.responseSchema);

    if (this.options?.logger) {
      this.options.logger(
        `[PromptGateway] ${input.purpose} | tokens: ${response.usage.input_tokens}+${response.usage.output_tokens} | context: ${assembled.totalTokensUsed}`
      );
    }

    return parsed;
  }
}

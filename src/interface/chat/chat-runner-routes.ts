import type { IAdapter, AgentTask } from "../../orchestrator/execution/adapter-layer.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse, ToolCallResult } from "../../base/llm/llm-client.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import type { ToolCallContext } from "../../tools/types.js";
import { toToolDefinitionsFiltered } from "../../tools/tool-definition-adapter.js";
import {
  buildPromptedToolProtocolSystemPrompt,
  extractPromptedToolCalls,
} from "../../orchestrator/execution/agent-loop/prompted-tool-protocol.js";
import { verifyChatAction } from "./chat-verifier.js";
import {
  collectGitDiffArtifact,
  formatToolActivity,
} from "./chat-runner-support.js";
import type { ChatUsageCounter } from "./chat-history.js";
import type { ChatRunResult, ChatRunnerDeps, RuntimeControlChatContext } from "./chat-runner.js";
import type { SelectedChatRoute } from "./ingress-router.js";
import type { ChatEventContext } from "./chat-events.js";
import type { AgentLoopSessionState } from "../../orchestrator/execution/agent-loop/agent-loop-session-state.js";
import { resolveExecutionPolicy, type ExecutionPolicy } from "../../orchestrator/execution/agent-loop/execution-policy.js";
import type { AssistantBuffer, ChatRunnerEventBridge } from "./chat-runner-event-bridge.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_VERIFY_RETRIES = 2;
const MAX_TOOL_LOOPS = 5;

export interface ChatRunnerRouteHost {
  deps: ChatRunnerDeps;
  eventBridge: ChatRunnerEventBridge;
  activatedTools: Set<string>;
  getSessionCwd(): string | null;
  getNativeAgentLoopStatePath(): string | null;
  getSessionExecutionPolicy(): Promise<ExecutionPolicy>;
  setSessionExecutionPolicy(policy: ExecutionPolicy): void;
}

export async function executeRuntimeControlRoute(
  host: ChatRunnerRouteHost,
  route: Extract<SelectedChatRoute, { kind: "runtime_control" }>,
  runtimeControlContext: RuntimeControlChatContext | null,
  cwd: string,
  start: number
): Promise<ChatRunResult> {
  if (!host.deps.runtimeControlService) {
    return {
      success: false,
      output: "Runtime control is not available in this chat surface yet.",
      elapsed_ms: Date.now() - start,
    };
  }

  const replyTarget = runtimeControlContext?.replyTarget ?? host.deps.runtimeReplyTarget;
  const actor = runtimeControlContext?.actor ?? host.deps.runtimeControlActor;
  const result = await host.deps.runtimeControlService.request({
    intent: route.intent,
    cwd,
    requestedBy: actor ?? {
      surface: replyTarget?.surface ?? "chat",
      platform: replyTarget?.platform,
      conversation_id: replyTarget?.conversation_id,
      identity_key: replyTarget?.identity_key,
      user_id: replyTarget?.user_id,
    },
    replyTarget: replyTarget ?? { surface: "chat" },
    approvalFn: runtimeControlContext?.approvalFn
      ?? host.deps.runtimeControlApprovalFn
      ?? host.deps.approvalFn,
  });

  return {
    success: result.success,
    output: result.message,
    elapsed_ms: Date.now() - start,
  };
}

export async function executeAgentLoopRoute(
  host: ChatRunnerRouteHost,
  params: {
    resumeOnly: boolean;
    executionCwd: string;
    executionGoalId?: string;
    basePrompt: string;
    priorTurns: Array<{ role: string; content: string }>;
    agentLoopSystemPrompt: string;
    assistantBuffer: AssistantBuffer;
    eventContext: ChatEventContext;
    history: {
      appendAssistantMessage(message: string): Promise<void>;
      recordUsage(phase: string, usage: ChatUsageCounter): void;
    };
    gitRoot: string;
    activeAbortSignal: AbortSignal;
    start: number;
  }
): Promise<ChatRunResult> {
  const {
    resumeOnly,
    executionCwd,
    executionGoalId,
    basePrompt,
    priorTurns,
    agentLoopSystemPrompt,
    assistantBuffer,
    eventContext,
    history,
    gitRoot,
    activeAbortSignal,
    start,
  } = params;
  try {
    const resumeState = resumeOnly ? await loadResumableAgentLoopState(host) : null;
    if (resumeOnly && !resumeState) {
      const elapsed_ms = Date.now() - start;
      const output = host.eventBridge.emitLifecycleErrorEvent(
        "No resumable native agentloop state found.",
        assistantBuffer.text,
        eventContext
      );
      host.eventBridge.emitLifecycleEndEvent("error", elapsed_ms, eventContext, false);
      return {
        success: false,
        output,
        elapsed_ms,
      };
    }
    host.eventBridge.emitCheckpoint(resumeOnly ? "Session resumed" : "Agent loop started", resumeOnly
      ? "Resumable agent-loop state is loaded."
      : "The agent loop can now inspect, plan, edit, or verify with visible tool activity.", eventContext, "execution");
    host.eventBridge.emitActivity("lifecycle", "Calling model...", eventContext, "lifecycle:model");
    const result = await host.deps.chatAgentLoopRunner!.execute({
      message: basePrompt,
      cwd: executionCwd,
      goalId: executionGoalId,
      history: priorTurns.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
      eventSink: host.eventBridge.createAgentLoopEventSink(eventContext),
      approvalFn: async (request) => {
        if (host.deps.approvalFn) {
          return host.deps.approvalFn(request.reason);
        }
        return false;
      },
      toolCallContext: {
        executionPolicy: await host.getSessionExecutionPolicy(),
      },
      ...(host.getNativeAgentLoopStatePath() ? { resumeStatePath: host.getNativeAgentLoopStatePath()! } : {}),
      ...(resumeState ? { resumeState } : {}),
      ...(resumeOnly ? { resumeOnly: true } : {}),
      ...(agentLoopSystemPrompt ? { systemPrompt: agentLoopSystemPrompt } : {}),
      abortSignal: activeAbortSignal,
    });
    const elapsed_ms = Date.now() - start;
    const agentLoopUsage = result.agentLoop?.usage
      ? normalizeUsageCounter(result.agentLoop.usage)
      : zeroUsageCounter();
    if (hasUsage(agentLoopUsage)) {
      history.recordUsage("agentloop", agentLoopUsage);
    }
    if (result.output) {
      host.eventBridge.pushAssistantDelta(result.output, assistantBuffer, eventContext);
    }
    if (result.success) {
      const diffArtifact = await collectGitDiffArtifact(gitRoot);
      if (diffArtifact) {
        host.eventBridge.emitDiffArtifact(diffArtifact, eventContext);
      }
      await history.appendAssistantMessage(result.output);
      host.eventBridge.emitCheckpoint("Response ready", "The agent-loop response has been persisted for this turn.", eventContext, "complete");
      host.eventBridge.emitActivity("lifecycle", "Finalizing response...", eventContext, "lifecycle:finalizing");
      host.eventBridge.emitEvent({
        type: "assistant_final",
        text: result.output,
        persisted: true,
        ...host.eventBridge.eventBase(eventContext),
      });
      host.eventBridge.emitLifecycleEndEvent("completed", elapsed_ms, eventContext, true);
    } else {
      result.output = host.eventBridge.emitLifecycleErrorEvent(result.output || result.error || "Unknown error", assistantBuffer.text, eventContext);
      host.eventBridge.emitLifecycleEndEvent("error", elapsed_ms, eventContext, false);
    }
    return {
      success: result.success,
      output: result.output,
      elapsed_ms,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output = host.eventBridge.emitLifecycleErrorEvent(message, assistantBuffer.text, eventContext);
    host.eventBridge.emitLifecycleEndEvent("error", Date.now() - start, eventContext, false);
    return {
      success: false,
      output,
      elapsed_ms: Date.now() - start,
    };
  }
}

export async function executeToolLoopRoute(
  host: ChatRunnerRouteHost,
  params: {
    prompt: string;
    eventContext: ChatEventContext;
    assistantBuffer: AssistantBuffer;
    systemPrompt?: string;
    executionGoalId?: string;
    history: {
      appendAssistantMessage(message: string): Promise<void>;
      recordUsage(phase: string, usage: ChatUsageCounter): void;
    };
    gitRoot: string;
    start: number;
  }
): Promise<ChatRunResult> {
  try {
    host.eventBridge.emitCheckpoint("Tool loop started", "The model will choose tools from the active catalog.", params.eventContext, "execution");
    const toolResult = await executeWithTools(
      host,
      params.prompt,
      params.eventContext,
      params.assistantBuffer,
      params.systemPrompt,
      params.executionGoalId
    );
    const elapsed_ms = Date.now() - params.start;
    if (hasUsage(toolResult.usage)) {
      params.history.recordUsage("execution", toolResult.usage);
    }
    const diffArtifact = await collectGitDiffArtifact(params.gitRoot);
    if (diffArtifact) {
      host.eventBridge.emitDiffArtifact(diffArtifact, params.eventContext);
    }
    await params.history.appendAssistantMessage(toolResult.output);
    host.eventBridge.emitCheckpoint("Response ready", "The tool-loop response has been persisted for this turn.", params.eventContext, "complete");
    host.eventBridge.emitActivity("lifecycle", "Finalizing response...", params.eventContext, "lifecycle:finalizing");
    host.eventBridge.emitEvent({
      type: "assistant_final",
      text: toolResult.output,
      persisted: true,
      ...host.eventBridge.eventBase(params.eventContext),
    });
    host.eventBridge.emitLifecycleEndEvent("completed", elapsed_ms, params.eventContext, true);
    return { success: true, output: toolResult.output, elapsed_ms };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output = host.eventBridge.emitLifecycleErrorEvent(message, params.assistantBuffer.text, params.eventContext);
    host.eventBridge.emitLifecycleEndEvent("error", Date.now() - params.start, params.eventContext, false);
    return {
      success: false,
      output,
      elapsed_ms: Date.now() - params.start,
    };
  }
}

export async function executeAdapterRoute(
  host: ChatRunnerRouteHost,
  params: {
    prompt: string;
    cwd: string;
    timeoutMs: number;
    systemPrompt?: string;
    eventContext: ChatEventContext;
    assistantBuffer: AssistantBuffer;
    gitRoot: string;
    start: number;
    history: {
      appendAssistantMessage(message: string): Promise<void>;
    };
  }
): Promise<ChatRunResult> {
  const task: AgentTask = {
    prompt: params.prompt,
    timeout_ms: params.timeoutMs,
    adapter_type: host.deps.adapter.adapterType,
    cwd: params.cwd,
    ...(params.systemPrompt ? { system_prompt: params.systemPrompt } : {}),
  };
  const resolvedTimeoutMs = task.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  host.eventBridge.emitCheckpoint("Adapter started", "The configured adapter has the current prompt and project context.", params.eventContext, "execution");
  host.eventBridge.emitActivity("lifecycle", "Calling adapter...", params.eventContext, "lifecycle:adapter");
  const adapterPromise = host.deps.adapter.execute(task);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Chat adapter timed out after ${resolvedTimeoutMs}ms`)), resolvedTimeoutMs)
  );
  let result: Awaited<ReturnType<IAdapter["execute"]>>;
  try {
    result = await Promise.race([adapterPromise, timeoutPromise]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output = host.eventBridge.emitLifecycleErrorEvent(message, params.assistantBuffer.text, params.eventContext);
    const timeoutElapsedMs = Date.now() - params.start;
    host.eventBridge.emitLifecycleEndEvent("error", timeoutElapsedMs, params.eventContext, false);
    return {
      success: false,
      output,
      elapsed_ms: timeoutElapsedMs,
    };
  }
  if (!result.output && result.error) {
    result = { ...result, output: `Error: ${result.error}` };
  }
  const elapsed_ms = Date.now() - params.start;
  if (result.output) {
    host.eventBridge.pushAssistantDelta(result.output, params.assistantBuffer, params.eventContext);
  }

  const diffArtifact = await collectGitDiffArtifact(params.gitRoot);
  if (diffArtifact) {
    let retries = 0;
    const VERIFY_TIMEOUT_MS = 30_000;
    host.eventBridge.emitCheckpoint("Changes detected", "Verification is starting because the turn changed the working tree.", params.eventContext, "changes");
    host.eventBridge.emitActivity("lifecycle", "Checking result...", params.eventContext, "lifecycle:checking");
    let verification = await Promise.race([
      verifyChatAction(params.gitRoot, host.deps.toolExecutor, { force: true }),
      new Promise<{ passed: true }>((resolve) =>
        setTimeout(() => resolve({ passed: true }), VERIFY_TIMEOUT_MS)
      ),
    ]);

    while (!verification.passed && retries < MAX_VERIFY_RETRIES) {
      retries++;
      host.eventBridge.emitCheckpoint("Verification retry", `Attempt ${retries} of ${MAX_VERIFY_RETRIES} is repairing failed checks.`, params.eventContext, `verification-retry-${retries}`);
      const retryPrompt = `The previous changes caused test failures. Please fix them.\n\nTest output:\n${verification.testOutput ?? verification.errors.join("\n")}`;
      const retryTask: AgentTask = { ...task, prompt: retryPrompt };
      result = await host.deps.adapter.execute(retryTask);
      verification = await verifyChatAction(params.gitRoot, host.deps.toolExecutor, { force: true });
    }

    if (!verification.passed) {
      const finalDiffArtifact = await collectGitDiffArtifact(params.gitRoot);
      if (finalDiffArtifact) {
        host.eventBridge.emitDiffArtifact(finalDiffArtifact, params.eventContext);
      }
      host.eventBridge.emitCheckpoint("Verification failed", `Checks are still failing after ${MAX_VERIFY_RETRIES} retries.`, params.eventContext, "verification");
      const failureOutput = host.eventBridge.emitLifecycleErrorEvent(
        `Changes applied but tests are still failing after ${MAX_VERIFY_RETRIES} retries.`,
        params.assistantBuffer.text,
        params.eventContext
      );
      host.eventBridge.emitLifecycleEndEvent("error", Date.now() - params.start, params.eventContext, false);
      return {
        success: false,
        output: `${failureOutput}\n\nTest output:\n${verification.testOutput ?? verification.errors.join("\n")}`.trim(),
        elapsed_ms: Date.now() - params.start,
      };
    }
    const finalDiffArtifact = await collectGitDiffArtifact(params.gitRoot);
    if (finalDiffArtifact) {
      host.eventBridge.emitDiffArtifact(finalDiffArtifact, params.eventContext);
    }
    host.eventBridge.emitCheckpoint("Verification passed", "Changed files passed the configured chat verification.", params.eventContext, "verification");
  }

  if (result.success) {
    await params.history.appendAssistantMessage(result.output);
    host.eventBridge.emitCheckpoint("Response ready", "The assistant response has been persisted for this turn.", params.eventContext, "complete");
    host.eventBridge.emitActivity("lifecycle", "Finalizing response...", params.eventContext, "lifecycle:finalizing");
    host.eventBridge.emitEvent({
      type: "assistant_final",
      text: result.output,
      persisted: true,
      ...host.eventBridge.eventBase(params.eventContext),
    });
    host.eventBridge.emitLifecycleEndEvent("completed", elapsed_ms, params.eventContext, true);
  } else {
    const partialText = params.assistantBuffer.text !== result.output ? params.assistantBuffer.text : "";
    result.output = host.eventBridge.emitLifecycleErrorEvent(result.output || result.error || "Unknown error", partialText, params.eventContext);
    host.eventBridge.emitLifecycleEndEvent("error", elapsed_ms, params.eventContext, false);
  }

  return {
    success: result.success,
    output: result.output,
    elapsed_ms,
  };
}

async function executeWithTools(
  host: ChatRunnerRouteHost,
  prompt: string,
  eventContext: ChatEventContext,
  assistantBuffer: AssistantBuffer,
  systemPrompt?: string,
  goalId?: string
): Promise<{ output: string; usage: ChatUsageCounter }> {
  const llmClient = host.deps.llmClient!;
  const messages: LLMMessage[] = [{ role: "user", content: prompt }];
  const toolCallContext = await buildToolCallContext(host, goalId);
  const usage = zeroUsageCounter();

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const tools = host.deps.registry
      ? toToolDefinitionsFiltered(host.deps.registry.listAll(), { activatedTools: host.activatedTools })
      : [];
    const supportsNativeToolCalling = llmClient.supportsToolCalling?.() !== false;
    let response: LLMResponse;
    try {
      host.eventBridge.emitActivity("lifecycle", "Calling model...", eventContext, "lifecycle:model");
      response = await sendLLMMessage(host, llmClient, messages, {
        ...(supportsNativeToolCalling
          ? { tools, ...(systemPrompt ? { system: systemPrompt } : {}) }
          : { system: buildPromptedToolProtocolSystemPrompt({ systemPrompt, tools }) }),
      }, assistantBuffer, eventContext);
    } catch (err) {
      console.error("[chat-runner] executeWithTools error:", err);
      const hint = err instanceof Error ? `: ${err.message}` : "";
      throw new Error(`Sorry, I encountered an error processing your request${hint}.`);
    }
    addUsageCounter(usage, usageFromLLMResponse(response));

    const toolCalls = response.tool_calls?.length
      ? response.tool_calls
      : supportsNativeToolCalling
        ? []
        : extractPromptedToolCalls({
            content: response.content,
            tools,
            createId: () => `prompted-${loop}-${crypto.randomUUID()}`,
          }).map((call): ToolCallResult => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.input ?? {}),
            },
          }));

    if (!supportsNativeToolCalling && toolCalls.length > 0) {
      assistantBuffer.text = "";
    }

    if (toolCalls.length === 0) {
      return {
        output: assistantBuffer.text || response.content || "(no response)",
        usage,
      };
    }

    messages.push({ role: "assistant", content: response.content || "" });

    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        // ignore parse errors, use empty args
      }
      const toolResult = await dispatchToolCall(
        host,
        tc.id,
        tc.function.name,
        args,
        toolCallContext,
        eventContext
      );
      if (tc.function.name === "tool_search") {
        activateToolSearchResults(host.activatedTools, toolResult);
      }
      messages.push({ role: "user", content: `Tool result for ${tc.function.name}:\n${toolResult}` });
    }
  }

  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  return {
    output: lastAssistant?.content || "I was unable to complete the request within the allowed tool call limit.",
    usage,
  };
}

async function dispatchToolCall(
  host: ChatRunnerRouteHost,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
  context: ToolCallContext,
  eventContext: ChatEventContext,
): Promise<string> {
  if (!host.deps.registry) {
    host.eventBridge.emitActivity("tool", formatToolActivity("Failed", name, "No tool registry configured"), eventContext, toolCallId);
    return JSON.stringify({ error: "No tool registry configured" });
  }
  const tool = host.deps.registry.get(name);
  if (!tool) {
    host.eventBridge.emitActivity("tool", formatToolActivity("Failed", name, `Unknown tool: ${name}`), eventContext, toolCallId);
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
  const startTime = Date.now();
  try {
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      host.eventBridge.emitActivity("tool", formatToolActivity("Failed", name, `Invalid input: ${parsed.error.message}`), eventContext, toolCallId);
      host.eventBridge.emitEvent({
        type: "tool_end",
        toolCallId,
        toolName: name,
        success: false,
        summary: `Invalid input: ${parsed.error.message}`,
        durationMs: Date.now() - startTime,
        ...host.eventBridge.eventBase(eventContext),
      });
      return JSON.stringify({ error: `Invalid input: ${parsed.error.message}` });
    }

    host.eventBridge.emitEvent({
      type: "tool_start",
      toolCallId,
      toolName: name,
      args,
      ...host.eventBridge.eventBase(eventContext),
    });
    host.eventBridge.emitActivity("tool", formatToolActivity("Running", name, JSON.stringify(args)), eventContext, toolCallId);

    let result: { success: boolean; summary: string; data?: unknown; error?: string };
    if (host.deps.toolExecutor) {
      host.eventBridge.emitEvent({
        type: "tool_update",
        toolCallId,
        toolName: name,
        status: "running",
        message: "running",
        ...host.eventBridge.eventBase(eventContext),
      });
      host.deps.onToolStart?.(name, args);
      result = await host.deps.toolExecutor.execute(name, parsed.data, context);
    } else {
      const permResult = await tool.checkPermissions(parsed.data, context);
      if (permResult.status === "denied") {
        host.eventBridge.emitEvent({
          type: "tool_end",
          toolCallId,
          toolName: name,
          success: false,
          summary: permResult.reason,
          durationMs: Date.now() - startTime,
          ...host.eventBridge.eventBase(eventContext),
        });
        return `Tool ${name} denied: ${permResult.reason}`;
      }
      if (permResult.status === "needs_approval") {
        host.eventBridge.emitActivity("tool", formatToolActivity("Running", name, `awaiting approval: ${permResult.reason}`), eventContext, toolCallId);
        host.eventBridge.emitEvent({
          type: "tool_update",
          toolCallId,
          toolName: name,
          status: "awaiting_approval",
          message: permResult.reason,
          ...host.eventBridge.eventBase(eventContext),
        });
        const approved = await context.approvalFn({
          toolName: name,
          input: parsed.data,
          reason: permResult.reason,
          permissionLevel: tool.metadata.permissionLevel,
          isDestructive: tool.metadata.isDestructive,
          reversibility: "unknown",
        });
        if (!approved) {
          host.eventBridge.emitEvent({
            type: "tool_end",
            toolCallId,
            toolName: name,
            success: false,
            summary: `Not approved: ${permResult.reason}`,
            durationMs: Date.now() - startTime,
            ...host.eventBridge.eventBase(eventContext),
          });
          return `Tool ${name} not approved: ${permResult.reason}`;
        }
      }
      host.eventBridge.emitEvent({
        type: "tool_update",
        toolCallId,
        toolName: name,
        status: "running",
        message: "running",
        ...host.eventBridge.eventBase(eventContext),
      });
      host.deps.onToolStart?.(name, args);
      result = await tool.call(parsed.data, context);
    }

    const durationMs = Date.now() - startTime;
    host.deps.onToolEnd?.(name, { success: result.success, summary: result.summary || "...", durationMs });
    host.eventBridge.emitActivity(
      "tool",
      formatToolActivity(result.success ? "Finished" : "Failed", name, result.summary || "..."),
      eventContext,
      toolCallId
    );
    host.eventBridge.emitEvent({
      type: "tool_update",
      toolCallId,
      toolName: name,
      status: "result",
      message: result.summary || "...",
      ...host.eventBridge.eventBase(eventContext),
    });
    host.eventBridge.emitEvent({
      type: "tool_end",
      toolCallId,
      toolName: name,
      success: result.success,
      summary: result.summary || "...",
      durationMs,
      ...host.eventBridge.eventBase(eventContext),
    });
    return result.data != null ? JSON.stringify(result.data) : (result.summary ?? "(no result)");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;
    host.deps.onToolEnd?.(name, { success: false, summary: message, durationMs });
    host.eventBridge.emitActivity("tool", formatToolActivity("Failed", name, message), eventContext, toolCallId);
    host.eventBridge.emitEvent({
      type: "tool_end",
      toolCallId,
      toolName: name,
      success: false,
      summary: message,
      durationMs,
      ...host.eventBridge.eventBase(eventContext),
    });
    return JSON.stringify({ error: `Tool ${name} failed: ${message}` });
  }
}

async function sendLLMMessage(
  host: ChatRunnerRouteHost,
  llmClient: ILLMClient,
  messages: LLMMessage[],
  options: LLMRequestOptions | undefined,
  assistantBuffer: AssistantBuffer,
  eventContext: ChatEventContext
): Promise<LLMResponse> {
  let streamed = false;
  if (llmClient.sendMessageStream) {
    const response = await llmClient.sendMessageStream(messages, options, {
      onTextDelta: (delta) => {
        streamed = true;
        host.eventBridge.pushAssistantDelta(delta, assistantBuffer, eventContext);
      },
    });
    if (!streamed && response.content) {
      host.eventBridge.pushAssistantDelta(response.content, assistantBuffer, eventContext);
    }
    return response;
  }

  const response = await llmClient.sendMessage(messages, options);
  if (response.content) {
    host.eventBridge.pushAssistantDelta(response.content, assistantBuffer, eventContext);
  }
  return response;
}

async function buildToolCallContext(host: ChatRunnerRouteHost, goalId = host.deps.goalId): Promise<ToolCallContext> {
  const executionPolicy = await host.getSessionExecutionPolicy();
  return {
    cwd: host.getSessionCwd() ?? process.cwd(),
    goalId: goalId ?? "",
    trustBalance: 0,
    preApproved: false,
    approvalFn: async (req) => {
      if (host.deps.approvalFn) {
        return host.deps.approvalFn(req.reason);
      }
      return false;
    },
    executionPolicy,
  };
}

async function loadResumableAgentLoopState(host: ChatRunnerRouteHost): Promise<AgentLoopSessionState | null> {
  if (!host.getNativeAgentLoopStatePath()) return null;
  const raw = await host.deps.stateManager.readRaw(host.getNativeAgentLoopStatePath()!);
  if (!isAgentLoopSessionState(raw)) return null;
  if (raw.status === "completed") return null;
  return {
    ...raw,
    messages: [...raw.messages],
    calledTools: [...raw.calledTools],
  };
}

function isAgentLoopSessionState(value: unknown): value is AgentLoopSessionState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["sessionId"] === "string"
    && typeof candidate["traceId"] === "string"
    && typeof candidate["turnId"] === "string"
    && typeof candidate["goalId"] === "string"
    && typeof candidate["cwd"] === "string"
    && typeof candidate["modelRef"] === "string"
    && Array.isArray(candidate["messages"])
    && Array.isArray(candidate["calledTools"])
    && typeof candidate["status"] === "string";
}

function activateToolSearchResults(activatedTools: Set<string>, toolResult: string): void {
  try {
    const parsed = JSON.parse(toolResult) as unknown;
    const results = Array.isArray(parsed) ? parsed : null;
    if (results) {
      for (const item of results) {
        if (item && typeof item === "object" && typeof (item as Record<string, unknown>)["name"] === "string") {
          activatedTools.add((item as Record<string, unknown>)["name"] as string);
        }
      }
    }
  } catch {
    // Non-JSON result or unexpected shape — ignore
  }
}

function zeroUsageCounter(): ChatUsageCounter {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function normalizeUsageCounter(usage: ChatUsageCounter): ChatUsageCounter {
  const inputTokens = Number.isFinite(usage.inputTokens) ? Math.max(0, Math.floor(usage.inputTokens)) : 0;
  const outputTokens = Number.isFinite(usage.outputTokens) ? Math.max(0, Math.floor(usage.outputTokens)) : 0;
  const totalTokens = Number.isFinite(usage.totalTokens)
    ? Math.max(0, Math.floor(usage.totalTokens))
    : inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function usageFromLLMResponse(response: LLMResponse): ChatUsageCounter {
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function addUsageCounter(target: ChatUsageCounter, delta: ChatUsageCounter): void {
  const normalizedDelta = normalizeUsageCounter(delta);
  target.inputTokens += normalizedDelta.inputTokens;
  target.outputTokens += normalizedDelta.outputTokens;
  target.totalTokens += normalizedDelta.totalTokens;
}

function hasUsage(usage: ChatUsageCounter): boolean {
  return usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0;
}

export async function resolveSessionExecutionPolicy(
  currentPolicy: ExecutionPolicy | null,
  sessionCwd: string | null
): Promise<ExecutionPolicy> {
  if (currentPolicy) return currentPolicy;
  const config = await loadProviderConfig({ saveMigration: false });
  return resolveExecutionPolicy({
    workspaceRoot: sessionCwd ?? process.cwd(),
    security: config.agent_loop?.security,
  });
}

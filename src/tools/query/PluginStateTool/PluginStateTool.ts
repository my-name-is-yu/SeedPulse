import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS } from "./constants.js";
import type { PluginLoader } from "../../../runtime/plugin-loader.js";
import { listBuiltinIntegrations } from "../../../runtime/builtin-integrations.js";

export const PluginStateToolInputSchema = z.object({
  pluginId: z.string().optional(),
});
export type PluginStateToolInput = z.infer<typeof PluginStateToolInputSchema>;

export class PluginStateTool implements ITool<PluginStateToolInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "get_plugins",
    aliases: ["plugin_state", "list_plugins"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = PluginStateToolInputSchema;

  constructor(private readonly pluginLoader: PluginLoader) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: PluginStateToolInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const allStates = await this.pluginLoader.loadAll();
      const plugins = allStates.map((p) => ({
        name: p.name,
        type: p.manifest.type,
        enabled: p.status === "loaded",
        status: p.status,
      }));
      const builtinIntegrations = listBuiltinIntegrations();

      if (input.pluginId) {
        const match = plugins.find((p) => p.name === input.pluginId);
        const builtinMatch = builtinIntegrations.find((integration) => integration.id === input.pluginId);
        if (builtinMatch) {
          return {
            success: true,
            data: builtinMatch,
            summary: `Builtin integration ${builtinMatch.id}: kind=${builtinMatch.kind}, status=${builtinMatch.status}`,
            durationMs: Date.now() - startTime,
          };
        }
        if (!match) {
          return {
            success: false,
            data: null,
            summary: `Plugin not found: ${input.pluginId}`,
            error: `Plugin not found: ${input.pluginId}`,
            durationMs: Date.now() - startTime,
          };
        }
        return {
          success: true,
          data: match,
          summary: `Plugin ${match.name}: type=${match.type}, enabled=${String(match.enabled)}, status=${match.status}`,
          durationMs: Date.now() - startTime,
        };
      }

      return {
        success: true,
        data: { plugins, builtin_integrations: builtinIntegrations },
        summary: `Found ${plugins.length} plugin(s) and ${builtinIntegrations.length} builtin integration(s)`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "PluginStateTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: PluginStateToolInput, _context?: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: PluginStateToolInput): boolean {
    return true;
  }
}

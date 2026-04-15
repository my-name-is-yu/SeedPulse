import * as path from "node:path";
import { execFileNoThrow, type ExecFileResult } from "../../base/utils/execFileNoThrow.js";
import { createSoilConfig, type SoilConfigInput } from "./config.js";
import { resolveSoilPageFilePath } from "./paths.js";
import { prepareSoilDisplaySnapshot } from "./display/index.js";

export type SoilOpenViewer = "default" | "finder" | "vscode" | "obsidian" | "logseq";
export type SoilOpenTarget =
  | "root"
  | "schedule_active"
  | "status"
  | "report"
  | "schedule"
  | "memory"
  | "knowledge"
  | "path";

export interface SoilOpenInput extends SoilConfigInput {
  viewer?: SoilOpenViewer;
  target?: SoilOpenTarget;
  targetPath?: string;
}

export interface SoilOpenCommand {
  command: string;
  args: string[];
  path: string;
  viewer: SoilOpenViewer;
  target: SoilOpenTarget;
}

export type SoilOpenRunner = (command: string, args: string[], options?: { timeoutMs?: number }) => Promise<ExecFileResult>;

export interface SoilOpenResult extends SoilOpenCommand {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function isInside(rootDir: string, candidate: string): boolean {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(candidate);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return resolved === root || resolved.startsWith(prefix);
}

export function resolveSoilOpenPath(input: SoilOpenInput): { rootDir: string; target: SoilOpenTarget; path: string } {
  const config = createSoilConfig(input);
  const target = input.target ?? "root";
  if (target === "path") {
    if (!input.targetPath) {
      throw new Error("targetPath is required when target is path");
    }
    const candidate = path.isAbsolute(input.targetPath)
      ? path.resolve(input.targetPath)
      : resolveSoilPageFilePath(config.rootDir, input.targetPath);
    if (!isInside(config.rootDir, candidate)) {
      throw new Error(`Soil open target escapes the root: ${input.targetPath}`);
    }
    return { rootDir: config.rootDir, target, path: candidate };
  }

  const relativeByTarget: Record<Exclude<SoilOpenTarget, "root" | "path">, string> = {
    schedule_active: path.join("schedule", "active.md"),
    status: "status.md",
    report: "report",
    schedule: "schedule",
    memory: "memory",
    knowledge: "knowledge",
  };
  const targetPath = target === "root" ? config.rootDir : path.join(config.rootDir, relativeByTarget[target]);
  return { rootDir: config.rootDir, target, path: targetPath };
}

function platformOpenCommand(targetPathOrUrl: string): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    return { command: "open", args: [targetPathOrUrl] };
  }
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", targetPathOrUrl] };
  }
  return { command: "xdg-open", args: [targetPathOrUrl] };
}

export function buildSoilOpenCommand(input: SoilOpenInput): SoilOpenCommand {
  const resolved = resolveSoilOpenPath(input);
  const viewer = input.viewer ?? "default";

  if (viewer === "vscode") {
    return { command: "code", args: [resolved.path], path: resolved.path, viewer, target: resolved.target };
  }
  if (viewer === "obsidian") {
    const url = `obsidian://open?path=${encodeURIComponent(resolved.path)}`;
    const command = platformOpenCommand(url);
    return { ...command, path: resolved.path, viewer, target: resolved.target };
  }
  if (viewer === "logseq") {
    const url = `logseq://graph/${encodeURIComponent(resolved.rootDir)}?page=${encodeURIComponent(resolved.path)}`;
    const command = platformOpenCommand(url);
    return { ...command, path: resolved.path, viewer, target: resolved.target };
  }

  const command = platformOpenCommand(resolved.path);
  if (viewer === "finder" && process.platform === "darwin") {
    return { command: "open", args: ["-R", resolved.path], path: resolved.path, viewer, target: resolved.target };
  }
  return { ...command, path: resolved.path, viewer, target: resolved.target };
}

export async function openSoil(input: SoilOpenInput, runner: SoilOpenRunner = execFileNoThrow): Promise<SoilOpenResult> {
  const command = buildSoilOpenCommand(input);
  await prepareSoilDisplaySnapshot({ rootDir: input.rootDir, indexPath: input.indexPath });
  const result = await runner(command.command, command.args, { timeoutMs: 10_000 });
  return {
    ...command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

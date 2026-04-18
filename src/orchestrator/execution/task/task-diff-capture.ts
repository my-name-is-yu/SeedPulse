import type { VerificationFileDiff } from "../../../base/types/task.js";

export type ExecFileSyncFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; encoding: "utf-8" }
) => string;

export interface ExecutionDiffArtifacts {
  changedPaths: string[];
  fileDiffs: VerificationFileDiff[];
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function readStdoutFromExecError(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "stdout" in error &&
    typeof (error as { stdout?: unknown }).stdout === "string"
  ) {
    return (error as { stdout: string }).stdout;
  }

  if (
    error &&
    typeof error === "object" &&
    "stdout" in error &&
    Buffer.isBuffer((error as { stdout?: unknown }).stdout)
  ) {
    return ((error as { stdout: Buffer }).stdout).toString("utf-8");
  }

  return "";
}

function runGitRead(
  execFileSyncFn: ExecFileSyncFn,
  cwd: string,
  args: string[],
): string {
  try {
    return execFileSyncFn("git", args, { cwd, encoding: "utf-8" });
  } catch (error) {
    return readStdoutFromExecError(error);
  }
}

export function captureExecutionDiffArtifacts(
  execFileSyncFn: ExecFileSyncFn,
  cwd: string,
): ExecutionDiffArtifacts {
  const trackedPaths = runGitRead(execFileSyncFn, cwd, ["diff", "--name-only"])
    .split("\n");
  const untrackedPaths = runGitRead(execFileSyncFn, cwd, ["ls-files", "--others", "--exclude-standard"])
    .split("\n");
  const changedPaths = uniqueNonEmpty([...trackedPaths, ...untrackedPaths]);
  const untrackedSet = new Set(uniqueNonEmpty(untrackedPaths));

  const fileDiffs = changedPaths.flatMap((path) => {
    const trackedPatch = runGitRead(execFileSyncFn, cwd, ["diff", "--", path]).trim();
    if (trackedPatch.length > 0) {
      return [{ path, patch: trackedPatch }];
    }

    if (!untrackedSet.has(path)) {
      return [];
    }

    const untrackedPatch = runGitRead(execFileSyncFn, cwd, ["diff", "--no-index", "--", "/dev/null", path]).trim();
    return untrackedPatch.length > 0 ? [{ path, patch: untrackedPatch }] : [];
  });

  return { changedPaths, fileDiffs };
}

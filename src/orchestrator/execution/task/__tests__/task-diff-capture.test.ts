import { describe, expect, it } from "vitest";
import { captureExecutionDiffArtifacts, type ExecFileSyncFn } from "../task-diff-capture.js";

function makeExecFileSync(outputs: Record<string, string>, thrownOutputs: Record<string, string> = {}): ExecFileSyncFn {
  return ((cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    if (key in thrownOutputs) {
      const error = new Error("command failed") as Error & { stdout?: string };
      error.stdout = thrownOutputs[key];
      throw error;
    }
    return outputs[key] ?? "";
  }) as ExecFileSyncFn;
}

describe("captureExecutionDiffArtifacts", () => {
  it("collects tracked file diffs and changed paths", () => {
    const execFileSyncFn = makeExecFileSync({
      "git diff --name-only": "src/example.ts\n",
      "git ls-files --others --exclude-standard": "",
      "git diff -- src/example.ts": "diff --git a/src/example.ts b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
    });

    const result = captureExecutionDiffArtifacts(execFileSyncFn, "/repo");

    expect(result.changedPaths).toEqual(["src/example.ts"]);
    expect(result.fileDiffs).toEqual([
      expect.objectContaining({
        path: "src/example.ts",
        patch: expect.stringContaining("+new"),
      }),
    ]);
  });

  it("captures untracked file diffs from git diff --no-index output", () => {
    const execFileSyncFn = makeExecFileSync(
      {
        "git diff --name-only": "",
        "git ls-files --others --exclude-standard": "src/new-file.ts\n",
        "git diff -- src/new-file.ts": "",
      },
      {
        "git diff --no-index -- /dev/null src/new-file.ts": [
          "diff --git a/src/new-file.ts b/src/new-file.ts",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/new-file.ts",
          "@@ -0,0 +1 @@",
          "+export const created = true;",
          "",
        ].join("\n"),
      },
    );

    const result = captureExecutionDiffArtifacts(execFileSyncFn, "/repo");

    expect(result.changedPaths).toEqual(["src/new-file.ts"]);
    expect(result.fileDiffs).toEqual([
      expect.objectContaining({
        path: "src/new-file.ts",
        patch: expect.stringContaining("new file mode 100644"),
      }),
    ]);
  });
});

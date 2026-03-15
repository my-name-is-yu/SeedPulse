# Approval Prompt Display Ordering — Root Cause Analysis

## Problem Summary

When running `motiva run --goal X --adapter github_issue`, the terminal shows:

```
[DEBUG] Task cycle result: action=completed, ...
[DEBUG] About to run task cycle with adapter: github_issue

--- Approval Required ---
Task: Create three GitHub issues...
Reversibility: irreversible
y
Approve this task? [y/N] [DEBUG-TL] Executing task ...
```

Three distinct anomalies:
1. `y` (the user's answer) appears BEFORE the `Approve this task? [y/N]` prompt
2. `[DEBUG-TL] Executing task ...` appears on the same line as the prompt, AFTER the answer
3. `[DEBUG] Task cycle result` and `[DEBUG] About to run task cycle` are printed in reverse order relative to actual execution

---

## Relevant Files and Lines

### src/cli-runner.ts — L81-94 (approval prompt)

```typescript
private buildApprovalFn(rl: readline.Interface): (task: Task) => Promise<boolean> {
  return (task: Task): Promise<boolean> => {
    return new Promise((resolve) => {
      console.log("\n--- Approval Required ---");
      console.log(`Task: ${task.work_description}`);
      console.log(`Rationale: ${task.rationale}`);
      console.log(`Reversibility: ${task.reversibility}`);

      rl.question("Approve this task? [y/N] ", (answer) => {  // L89
        resolve(answer.trim().toLowerCase() === "y");
      });
    });
  };
}
```

- `readline.Interface` is created at L215-218 with `output: process.stdout`
- `rl.question(...)` writes its prompt string to `stdout` via the readline interface

### src/cli-runner.ts — L215-218 (readline creation)

```typescript
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
```

### src/task-lifecycle.ts — L824, L826, L837 (DEBUG logs)

```
L824: console.log(`[DEBUG-TL] Executing task ${task.id} via adapter ...`)
L826: console.log(`[DEBUG-TL] Execution result: success=...`)
L837: console.log(`[DEBUG-TL] Verification: verdict=...`)
```

### src/core-loop.ts — L886, L894 (DEBUG logs)

```
L886: console.log(`[DEBUG] About to run task cycle with adapter: ...`)
L894: console.log(`[DEBUG] Task cycle result: action=...`)
```

**Execution order in task-lifecycle.ts runTaskCycle() (L798-L846):**
1. L799: `checkIrreversibleApproval(task)` → calls `approvalFn(task)` → calls `rl.question(...)` → waits for user input
2. L824: `console.log([DEBUG-TL] Executing task ...)` — printed AFTER approval resolves
3. L825: `executeTask(...)` runs
4. L826: `console.log([DEBUG-TL] Execution result ...)`
5. L837: `console.log([DEBUG-TL] Verification ...)`

**Execution order in core-loop.ts (L886-L894):**
1. L886: `console.log([DEBUG] About to run task cycle ...)` — printed BEFORE `runTaskCycle()` is called
2. L887-893: `await this.deps.taskLifecycle.runTaskCycle(...)` — during which approval happens
3. L894: `console.log([DEBUG] Task cycle result ...)` — printed AFTER the full cycle including approval

---

## Root Cause Analysis

### Cause 1: stdout buffering + readline internal echo (PRIMARY)

`readline.question()` writes its prompt string (`"Approve this task? [y/N] "`) to `stdout` through the readline interface. However, Node.js's `process.stdout` is a **non-blocking stream in TTY mode** but the readline library internally may defer the prompt display until the event loop tick resolves. Meanwhile:

- `console.log(...)` calls before `rl.question(...)` (lines 84-87) go directly to stdout synchronously
- `rl.question(...)` schedules its prompt write through the readline internal queue

When stdin has data buffered (e.g., the user typed `y` + Enter ahead of time, or there is pipe input), readline's internal `_normalWrite` echo path can process the keystrokes BEFORE `rl.question()` has flushed its prompt string to the TTY. This causes the input echo (`y`) to appear before the prompt string.

### Cause 2: Terminal echo of stdin (SECONDARY)

The TTY echoes characters typed by the user back to stdout. When the user types `y` and hits Enter, the TTY itself echoes `y\n` to the screen. The readline interface then appends its prompt string (`"Approve this task? [y/N] "`) to the output stream. If the TTY echo happens before readline flushes the prompt, the screen shows:

```
y
Approve this task? [y/N]
```

This is the exact symptom reported.

### Cause 3: `[DEBUG-TL] Executing task` appearing after the prompt line

`[DEBUG-TL] Executing task` is printed at `task-lifecycle.ts:824` — AFTER `rl.question()` resolves (approval is awaited). The readline interface does NOT add a newline after the user's answer. So stdout has:

```
Approve this task? [y/N] y\n
```

But readline may leave the cursor on the same line, and the next `console.log(...)` call appends to it. This makes `[DEBUG-TL] Executing task ...` appear on the same line as the prompt.

### Cause 4: `[DEBUG] Task cycle result` appearing before `[DEBUG] About to run task cycle`

This is **NOT** actually a code ordering bug. The output shown in the problem statement shows `Task cycle result` ABOVE `About to run task cycle` because they are from DIFFERENT loop iterations:

- The first block (`Task cycle result: action=completed`) is from the PREVIOUS loop iteration completing at `core-loop.ts:894`
- The second block (`About to run task cycle`) is from the NEXT iteration starting at `core-loop.ts:886`
- The approval prompt belongs to the current (second) iteration

So the order is actually correct in execution — it only looks reversed because the user reads the terminal top-to-bottom and misidentifies which iteration each log belongs to. **This is NOT a bug.**

---

## Suggested Fix

### Fix 1: Flush stdout before calling rl.question (low-risk, targeted)

Before calling `rl.question(...)`, ensure all buffered stdout output is drained. Node.js provides `process.stdout.write('', callback)` as a flush mechanism, but for TTY streams the simpler pattern is to avoid mixing `console.log` and `rl.question` — print everything through `process.stdout.write` to serialize output.

In `src/cli-runner.ts` `buildApprovalFn`, change `rl.question(...)` to print all lines through `process.stdout.write` and then read via `rl.question`. This does not fully solve the echo issue.

### Fix 2: Pause readline before printing, resume after (RECOMMENDED)

The readline `Interface` has `pause()` and `resume()` methods. The pattern to prevent TTY echo from appearing before the prompt is:

```typescript
private buildApprovalFn(rl: readline.Interface): (task: Task) => Promise<boolean> {
  return (task: Task): Promise<boolean> => {
    return new Promise((resolve) => {
      // Pause readline to prevent buffered stdin from racing the prompt display
      rl.pause();

      // Use process.stdout.write to avoid console.log's async path
      process.stdout.write("\n--- Approval Required ---\n");
      process.stdout.write(`Task: ${task.work_description}\n`);
      process.stdout.write(`Rationale: ${task.rationale}\n`);
      process.stdout.write(`Reversibility: ${task.reversibility}\n`);

      // Resume before calling rl.question so input is accepted
      rl.resume();

      rl.question("Approve this task? [y/N] ", (answer) => {
        // Add newline after answer so next console.log starts on a fresh line
        process.stdout.write("\n");
        resolve(answer.trim().toLowerCase() === "y");
      });
    });
  };
}
```

The `process.stdout.write("\n")` inside the callback ensures that subsequent `console.log(...)` calls (e.g., `[DEBUG-TL] Executing task`) start on their own line.

### Fix 3: Remove or gate debug logs behind a flag (ALSO RECOMMENDED)

The `[DEBUG-TL]` and `[DEBUG]` logs at:
- `task-lifecycle.ts` L824, L826, L837
- `core-loop.ts` L464, L471, L886, L894

...are development-only traces left in the code. They should be gated behind an environment variable (e.g., `MOTIVA_DEBUG=true`) or removed entirely. This eliminates the interleaving problem entirely for normal runs.

Example gate pattern:
```typescript
const DEBUG = process.env.MOTIVA_DEBUG === "true";
if (DEBUG) console.log(`[DEBUG-TL] Executing task ${task.id} ...`);
```

### Fix 4: Print a newline after rl.question callback (MINIMAL, fast fix)

The smallest targeted fix that prevents `[DEBUG-TL] Executing task` from appearing on the same line as the prompt:

In `src/cli-runner.ts` L89-91, add `process.stdout.write("\n")` before resolving:

```typescript
rl.question("Approve this task? [y/N] ", (answer) => {
  process.stdout.write("\n");  // ensure next output starts on new line
  resolve(answer.trim().toLowerCase() === "y");
});
```

---

## Summary Table

| Anomaly | Root Cause | Fix |
|---------|-----------|-----|
| `y` appears before prompt | TTY echo races readline prompt flush | Fix 2 (pause/resume + stdout.write) |
| `[DEBUG-TL]` on same line as prompt | No newline after readline answer | Fix 4 (minimal) or Fix 2 |
| `[DEBUG]` logs interleaved during approval | Debug logs surround the awaited approval call | Fix 3 (gate behind env var) |
| `Task cycle result` above `About to run` | Different loop iterations — NOT a bug | No fix needed |

**Recommended minimal fix:** Fix 4 (1 line, prevents the most jarring visual) + Fix 3 (gate debug logs). Fix 2 is more thorough if the echo-before-prompt issue needs solving completely.

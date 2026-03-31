#!/bin/bash
# Gradual gap decrease dogfooding — verifies gap decreases across multiple
# iterations (e.g., 1.0→0.8→0.6→0.4→0.2→0.0) rather than jumping in one step.
# Run from project root: bash scripts/dogfood-gradual.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PULSEED="node dist/cli-runner.js"
DATE="$(date +%Y-%m-%d)"
TMP_WORKSPACE="/tmp/pulseed-dogfood-gradual-$$"
REPORT_FILE="$REPO_DIR/memory/dogfood-gradual-${DATE}.md"

# --- Cleanup on exit ---
cleanup() {
  if [ -d "$TMP_WORKSPACE" ]; then
    rm -rf "$TMP_WORKSPACE"
    echo "Cleaned up $TMP_WORKSPACE"
  fi
}
trap cleanup EXIT

echo "=== Gradual Gap Decrease Dogfooding $(date) ==="
echo "Workspace: $TMP_WORKSPACE"
echo "Report: $REPORT_FILE"

# --- Build ---
echo "--- Building project ---"
npm run build >/dev/null

# --- Create temp workspace ---
echo "--- Creating temp workspace ---"
mkdir -p "$TMP_WORKSPACE/src"

cat > "$TMP_WORKSPACE/package.json" <<'JSON'
{
  "name": "dogfood-gradual",
  "version": "0.1.0",
  "type": "module"
}
JSON

cat > "$TMP_WORKSPACE/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
JSON

cat > "$TMP_WORKSPACE/src/string-utils.ts" <<'TS'
// TODO: add input validation for empty strings
// TODO: handle unicode characters properly
// FIXME: capitalize doesn't handle multi-word strings
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// TODO: add support for custom delimiters
// FIXME: joinWords crashes on empty array
export function joinWords(words: string[]): string {
  return words.join(' ');
}

// TODO: implement truncation with ellipsis
export function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}
TS

cat > "$TMP_WORKSPACE/src/math-utils.ts" <<'TS'
// TODO: add overflow protection
// FIXME: clamp doesn't validate min < max
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// TODO: handle negative numbers
export function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

// FIXME: average returns NaN for empty array
export function average(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
TS

cat > "$TMP_WORKSPACE/src/array-utils.ts" <<'TS'
// TODO: add type safety for mixed arrays
// TODO: support nested array flattening
// FIXME: unique doesn't work for object arrays
export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// TODO: add predicate-based chunking
export function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
TS

cat > "$TMP_WORKSPACE/src/index.ts" <<'TS'
// TODO: add re-exports for all utility modules
// FIXME: missing default export
export { capitalize, joinWords, truncate } from './string-utils.js';
export { clamp, factorial, average } from './math-utils.js';
export { unique, chunk } from './array-utils.js';
TS

# Initialize as git repo (observation engine uses git diff)
(cd "$TMP_WORKSPACE" && git init -q && git add -A && git commit -q -m "initial seed")
echo "Workspace seed files created (git initialized)."
echo "Initial state: 10 TODOs, 6 FIXMEs, 0 tests across 4 source files."

# --- Register goal ---
echo "--- Registering goal ---"
GOAL_OUTPUT=$($PULSEED goal add \
  --title "gradual-gap-test" \
  --dim "test_count:min:10" \
  --dim "todo_count:max:5" \
  --dim "fixme_count:max:3" \
  --constraint "workspace_path:$TMP_WORKSPACE" 2>&1)

echo "$GOAL_OUTPUT"
GOAL_ID=$(echo "$GOAL_OUTPUT" | grep "^Goal ID:" | awk '{print $NF}')

if [ -z "$GOAL_ID" ]; then
  echo "ERROR: Failed to parse Goal ID from goal add output"
  exit 1
fi

echo "Goal ID: $GOAL_ID"

# --- Run pulseed ---
echo "--- Running pulseed (max 12 iterations) ---"
RUN_LOG="/tmp/pulseed-dogfood-gradual-run-$$.log"
$PULSEED run --goal "$GOAL_ID" --yes --max-iterations 12 2>&1 | tee "$RUN_LOG"
RUN_EXIT="${PIPESTATUS[0]}"

echo "Run exit code: $RUN_EXIT"

# --- Parse gap progression ---
echo "--- Parsing gap progression ---"
GAP_LINES=$(grep -i "gap\|cv\|current_value\|threshold" "$RUN_LOG" || true)

# --- Write markdown report ---
mkdir -p "$(dirname "$REPORT_FILE")"

cat > "$REPORT_FILE" <<MDHEADER
# Gradual Gap Decrease Dogfood — ${DATE}

## Summary

- **Goal ID**: ${GOAL_ID}
- **Workspace**: ${TMP_WORKSPACE}
- **Dimensions**: \`test_count:min:10\`, \`todo_count:max:5\`, \`fixme_count:max:3\`
- **Max iterations**: 12
- **Run exit code**: ${RUN_EXIT}

## Objective

Verify that gap decreases gradually across multiple iterations rather than
jumping from 1.0 to 0.0 in a single step.

Initial state:
- \`test_count\`: 0 tests → gap=1.0 (below min of 10)
- \`todo_count\`: 10 TODOs → gap=1.0 (above max of 5, raw=(10-5)/5=1.0)
- \`fixme_count\`: 6 FIXMEs → gap=1.0 (above max of 3, raw=(6-3)/3=1.0)

Expected gap steps:
- \`test_count\`: 1.0→0.8→0.6→0.4→0.2→0.0 (adding ~2 tests per iteration)
- \`todo_count\`: 1.0→0.6→0.4→0.2→0.0 (resolving ~2 TODOs per iteration)
- \`fixme_count\`: 1.0→0.67→0.33→0.0 (resolving ~2 FIXMEs per iteration)

## Gap Progression (raw output lines)

\`\`\`
MDHEADER

if [ -n "$GAP_LINES" ]; then
  echo "$GAP_LINES" >> "$REPORT_FILE"
else
  echo "(no gap/cv lines found — check full log below)" >> "$REPORT_FILE"
fi

cat >> "$REPORT_FILE" <<'MDSEP'
```

## Full Run Log

```
MDSEP

cat "$RUN_LOG" >> "$REPORT_FILE"

cat >> "$REPORT_FILE" <<'MDFOOTER'
```

## Verification Checklist

- [ ] test_count gap shows multiple intermediate values (not just 0.0/1.0)
- [ ] todo_count gap shows multiple intermediate values
- [ ] fixme_count gap shows multiple intermediate values
- [ ] gap values decrease across iterations
- [ ] Final status is "completed"
MDFOOTER

rm -f "$RUN_LOG"

echo ""
echo "=== Dogfooding complete $(date) ==="
echo "Report: $REPORT_FILE"

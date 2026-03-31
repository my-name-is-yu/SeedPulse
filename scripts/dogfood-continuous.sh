#!/bin/bash
# Continuous value gap dogfooding — verifies min/max threshold types produce
# intermediate gap values (e.g., cv=0.4, gap=0.6) rather than binary 0/1.
# Run from project root: bash scripts/dogfood-continuous.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PULSEED="node dist/cli-runner.js"
DATE="$(date +%Y-%m-%d)"
TMP_WORKSPACE="/tmp/pulseed-dogfood-continuous-$$"
REPORT_FILE="$REPO_DIR/memory/dogfood-continuous-${DATE}.md"

# --- Cleanup on exit ---
cleanup() {
  if [ -d "$TMP_WORKSPACE" ]; then
    rm -rf "$TMP_WORKSPACE"
    echo "Cleaned up $TMP_WORKSPACE"
  fi
}
trap cleanup EXIT

echo "=== Continuous Value Gap Dogfooding $(date) ==="
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
  "name": "dogfood-continuous",
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

cat > "$TMP_WORKSPACE/src/utils.ts" <<'TS'
// TODO: add input validation
// TODO: handle edge cases for empty strings
// TODO: add JSDoc documentation
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// TODO: support custom delimiters
export function joinWords(words: string[]): string {
  // TODO: handle null/undefined elements
  return words.join(' ');
}
TS

cat > "$TMP_WORKSPACE/src/index.ts" <<'TS'
import { capitalize, joinWords } from './utils.js';

// TODO: add CLI argument parsing
export function greet(name: string): string {
  return capitalize(joinWords(['hello', name]));
}
TS

# Initialize as git repo (observation engine uses git diff)
(cd "$TMP_WORKSPACE" && git init -q && git add -A && git commit -q -m "initial seed")
echo "Workspace seed files created (git initialized)."

# --- Register goal ---
echo "--- Registering goal ---"
GOAL_OUTPUT=$($PULSEED goal add \
  --title "continuous-value-test" \
  --dim "test_count:min:5" \
  --dim "todo_count:max:4" \
  --constraint "workspace_path:$TMP_WORKSPACE" 2>&1)

echo "$GOAL_OUTPUT"
GOAL_ID=$(echo "$GOAL_OUTPUT" | grep "^Goal ID:" | awk '{print $NF}')

if [ -z "$GOAL_ID" ]; then
  echo "ERROR: Failed to parse Goal ID from goal add output"
  exit 1
fi

echo "Goal ID: $GOAL_ID"

# --- Run pulseed ---
echo "--- Running pulseed (max 8 iterations) ---"
RUN_LOG="/tmp/pulseed-dogfood-continuous-run-$$.log"
$PULSEED run --goal "$GOAL_ID" --yes --max-iterations 8 2>&1 | tee "$RUN_LOG"
RUN_EXIT="${PIPESTATUS[0]}"

echo "Run exit code: $RUN_EXIT"

# --- Parse gap progression ---
echo "--- Parsing gap progression ---"
GAP_LINES=$(grep -i "gap\|cv\|current_value\|threshold" "$RUN_LOG" || true)

# --- Write markdown report ---
mkdir -p "$(dirname "$REPORT_FILE")"

cat > "$REPORT_FILE" <<MDHEADER
# Continuous Value Gap Dogfood — ${DATE}

## Summary

- **Goal ID**: ${GOAL_ID}
- **Workspace**: ${TMP_WORKSPACE}
- **Dimensions**: \`test_count:min:5\`, \`todo_count:max:4\`
- **Max iterations**: 8
- **Run exit code**: ${RUN_EXIT}

## Objective

Verify that \`min\`/\`max\` threshold types produce intermediate gap values
(e.g., \`cv=0.4, gap=0.6\`) rather than binary 0/1.

Initial state:
- \`test_count\`: 0 tests → gap=1.0 (below min of 5)
- \`todo_count\`: 6 TODOs → gap=0.5 (above max of 4, raw=(6-4)/4=0.5)

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

- [ ] gap values are fractional (not only 0.0 or 1.0)
- [ ] gap decreases across iterations as agent makes progress
- [ ] `test_count` gap converges toward 0 as tests are added
- [ ] `todo_count` gap converges toward 0 as TODOs are resolved
MDFOOTER

rm -f "$RUN_LOG"

echo ""
echo "=== Dogfooding complete $(date) ==="
echo "Report: $REPORT_FILE"

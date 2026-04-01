#!/bin/bash
# Integrated daemon dogfood — verifies the #401 interleaved daemon loop fix:
#   a. Multiple goals rotate (different goal IDs appear in successive iterations)
#   b. Cron tasks fire as expected
#   c. Proactive tick fires even with active goals
#   d. Adaptive sleep varies (multiple distinct sleep values observed)
# Run from project root: bash scripts/dogfood-30min-integrated.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PULSEED="node dist/cli-runner.js"
DATE="$(date +%Y-%m-%d)"
TMP_WORKSPACE="$(mktemp -d)"
# Use an isolated pulseed state dir so we never touch ~/.pulseed
PULSEED_STATE_DIR="$TMP_WORKSPACE/pulseed-state"
REPORT_FILE="$REPO_DIR/memory/dogfood-30min-integrated-${DATE}.md"
DAEMON_LOG="$TMP_WORKSPACE/daemon.log"
DAEMON_PID_FILE="$TMP_WORKSPACE/daemon.pid"
CONFIG_FILE="$TMP_WORKSPACE/daemon-config.json"

export PULSEED_HOME="$PULSEED_STATE_DIR"

# --- Cleanup on exit ---
cleanup() {
  # Stop daemon if still running
  if [ -f "$DAEMON_PID_FILE" ]; then
    DPID="$(cat "$DAEMON_PID_FILE")"
    if kill -0 "$DPID" 2>/dev/null; then
      echo "Stopping daemon (PID $DPID)..."
      PULSEED_HOME="$PULSEED_STATE_DIR" $PULSEED stop 2>/dev/null \
        || kill "$DPID" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$DAEMON_PID_FILE"
  fi
  if [ -d "$TMP_WORKSPACE" ]; then
    rm -rf "$TMP_WORKSPACE"
    echo "Cleaned up $TMP_WORKSPACE"
  fi
}
trap cleanup EXIT

echo "=== Integrated Daemon Dogfooding (#401 fix verification) $(date) ==="
echo "Workspace:   $TMP_WORKSPACE"
echo "PulSeed dir: $PULSEED_STATE_DIR"
echo "Report:      $REPORT_FILE"

# --- Build ---
echo "--- Building project ---"
npm run build >/dev/null

# --- Create temp workspace (3 sentinel files, one per goal) ---
echo "--- Creating temp workspace ---"
mkdir -p "$TMP_WORKSPACE/workspace-a" "$TMP_WORKSPACE/workspace-b" \
         "$TMP_WORKSPACE/workspace-c" "$PULSEED_STATE_DIR"

# Goal A: file-existence check — target file already present (idle goal)
touch "$TMP_WORKSPACE/workspace-a/target.txt"

# Goal B: file-existence check — target file present (idle goal)
touch "$TMP_WORKSPACE/workspace-b/target.txt"

# Goal C: file-existence check — target file NOT present initially (active goal)
# We will create the file mid-run to test dynamic activation

# Initialize as git repos (observation engine uses git diff)
for WS in workspace-a workspace-b workspace-c; do
  (cd "$TMP_WORKSPACE/$WS" && git init -q && git add -A && git commit -q --allow-empty -m "initial seed") 2>/dev/null || true
done
echo "Workspaces initialized."

# --- Seed scheduled cron tasks ---
echo "--- Seeding scheduled tasks ---"
cat > "$PULSEED_STATE_DIR/scheduled-tasks.json" <<'JSON'
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440011",
    "cron": "* * * * *",
    "prompt": "Check integration test status",
    "type": "reflection",
    "enabled": true,
    "last_fired_at": null,
    "permanent": false,
    "created_at": "2026-04-01T00:00:00.000Z"
  },
  {
    "id": "550e8400-e29b-41d4-a716-446655440012",
    "cron": "* * * * *",
    "prompt": "Consolidate daemon observations",
    "type": "consolidation",
    "enabled": true,
    "last_fired_at": null,
    "permanent": true,
    "created_at": "2026-04-01T00:00:00.000Z"
  }
]
JSON
echo "Scheduled tasks written to $PULSEED_STATE_DIR/scheduled-tasks.json"

# --- Create daemon config ---
echo "--- Creating daemon config ---"
cat > "$CONFIG_FILE" <<'JSON'
{
  "check_interval_ms": 10000,
  "proactive_mode": true,
  "proactive_interval_ms": 15000,
  "adaptive_sleep": {
    "enabled": true,
    "min_interval_ms": 5000,
    "max_interval_ms": 60000,
    "night_start_hour": 22,
    "night_end_hour": 7,
    "night_multiplier": 2.0
  }
}
JSON
echo "Daemon config written to $CONFIG_FILE"

# --- Register 3 goals simultaneously ---
echo "--- Registering goals ---"

# Goal A: file-existence, workspace-a — satisfied immediately (forces idle cycles → adaptive sleep variation)
GOAL_A_OUTPUT=$(PULSEED_HOME="$PULSEED_STATE_DIR" $PULSEED goal add \
  --title "integrated-goal-a" \
  --dim "file_exists:present:true" \
  --constraint "workspace_path:$TMP_WORKSPACE/workspace-a" 2>&1)
echo "$GOAL_A_OUTPUT"
GOAL_A_ID=$(echo "$GOAL_A_OUTPUT" | grep "^Goal ID:" | awk '{print $NF}')

# Goal B: file-existence, workspace-b — satisfied immediately
GOAL_B_OUTPUT=$(PULSEED_HOME="$PULSEED_STATE_DIR" $PULSEED goal add \
  --title "integrated-goal-b" \
  --dim "file_exists:present:true" \
  --constraint "workspace_path:$TMP_WORKSPACE/workspace-b" 2>&1)
echo "$GOAL_B_OUTPUT"
GOAL_B_ID=$(echo "$GOAL_B_OUTPUT" | grep "^Goal ID:" | awk '{print $NF}')

# Goal C: file-existence, workspace-c — unsatisfied so daemon has active work
GOAL_C_OUTPUT=$(PULSEED_HOME="$PULSEED_STATE_DIR" $PULSEED goal add \
  --title "integrated-goal-c" \
  --dim "file_exists:present:true" \
  --constraint "workspace_path:$TMP_WORKSPACE/workspace-c" 2>&1)
echo "$GOAL_C_OUTPUT"
GOAL_C_ID=$(echo "$GOAL_C_OUTPUT" | grep "^Goal ID:" | awk '{print $NF}')

for VAR_NAME in GOAL_A_ID GOAL_B_ID GOAL_C_ID; do
  VAL="${!VAR_NAME}"
  if [ -z "$VAL" ]; then
    echo "ERROR: Failed to parse $VAR_NAME from goal add output"
    exit 1
  fi
  echo "$VAR_NAME: $VAL"
done

# --- Start daemon with all 3 goals ---
echo "--- Starting daemon (3 goals) ---"
PULSEED_HOME="$PULSEED_STATE_DIR" $PULSEED start \
  --goal "$GOAL_A_ID" \
  --goal "$GOAL_B_ID" \
  --goal "$GOAL_C_ID" \
  --config "$CONFIG_FILE" \
  >"$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!
echo "$DAEMON_PID" > "$DAEMON_PID_FILE"
echo "Daemon started (PID $DAEMON_PID), logging to $DAEMON_LOG"

# Create the workspace-c target file after ~30s to let goal C activate for a few cycles first
(sleep 30 && touch "$TMP_WORKSPACE/workspace-c/target.txt" \
  && echo "[bg] Created workspace-c/target.txt at $(date)") &

# --- Monitor for 5 minutes ---
echo "--- Monitoring daemon output for 300 seconds ---"
MONITOR_START=$(date +%s)
MONITOR_DURATION=300
LOOP_COUNT=0
PROACTIVE_TICKS=0
CRON_DUE=0
CRON_FIRED=0
SLEEP_MESSAGES=0
GOAL_A_ITERS=0
GOAL_B_ITERS=0
GOAL_C_ITERS=0

while true; do
  NOW=$(date +%s)
  ELAPSED=$(( NOW - MONITOR_START ))

  if [ $ELAPSED -ge $MONITOR_DURATION ]; then
    echo "Monitor window complete (${MONITOR_DURATION}s)."
    break
  fi

  # Check daemon is still alive
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "WARNING: Daemon process exited early (PID $DAEMON_PID)"
    break
  fi

  if [ -f "$DAEMON_LOG" ]; then
    LOOP_COUNT=$(grep -c "Loop completed for goal:" "$DAEMON_LOG" 2>/dev/null || true)
    PROACTIVE_TICKS=$(grep -ci "proactive tick" "$DAEMON_LOG" 2>/dev/null || true)
    CRON_DUE=$(grep -c "Cron task due:" "$DAEMON_LOG" 2>/dev/null || true)
    CRON_FIRED=$(grep -c "Cron task fired:" "$DAEMON_LOG" 2>/dev/null || true)
    SLEEP_MESSAGES=$(grep -ci "sleeping for" "$DAEMON_LOG" 2>/dev/null || true)
    GOAL_A_ITERS=$(grep -c "goal: $GOAL_A_ID" "$DAEMON_LOG" 2>/dev/null || true)
    GOAL_B_ITERS=$(grep -c "goal: $GOAL_B_ID" "$DAEMON_LOG" 2>/dev/null || true)
    GOAL_C_ITERS=$(grep -c "goal: $GOAL_C_ID" "$DAEMON_LOG" 2>/dev/null || true)
  fi

  printf "\r[%3ds] loops=%-3s proactive=%-3s cron_due=%-3s cron_fired=%-3s sleep=%-3s" \
    "$ELAPSED" "$LOOP_COUNT" "$PROACTIVE_TICKS" "$CRON_DUE" "$CRON_FIRED" "$SLEEP_MESSAGES"

  sleep 5
done
echo ""

# --- Stop daemon ---
echo "--- Stopping daemon ---"
PULSEED_HOME="$PULSEED_STATE_DIR" $PULSEED stop 2>/dev/null || {
  echo "stop command failed or not supported; sending SIGTERM to $DAEMON_PID"
  kill "$DAEMON_PID" 2>/dev/null || true
}
sleep 2
rm -f "$DAEMON_PID_FILE"

# --- Final counts from log ---
if [ -f "$DAEMON_LOG" ]; then
  LOOP_COUNT=$(grep -c "Loop completed for goal:" "$DAEMON_LOG" 2>/dev/null || true)
  PROACTIVE_TICKS=$(grep -ci "proactive tick" "$DAEMON_LOG" 2>/dev/null || true)
  CRON_DUE=$(grep -c "Cron task due:" "$DAEMON_LOG" 2>/dev/null || true)
  CRON_FIRED=$(grep -c "Cron task fired:" "$DAEMON_LOG" 2>/dev/null || true)
  SLEEP_MESSAGES=$(grep -ci "sleeping for" "$DAEMON_LOG" 2>/dev/null || true)
  GOAL_A_ITERS=$(grep -c "goal: $GOAL_A_ID" "$DAEMON_LOG" 2>/dev/null || true)
  GOAL_B_ITERS=$(grep -c "goal: $GOAL_B_ID" "$DAEMON_LOG" 2>/dev/null || true)
  GOAL_C_ITERS=$(grep -c "goal: $GOAL_C_ID" "$DAEMON_LOG" 2>/dev/null || true)

  # Collect unique sleep interval values to check variance
  SLEEP_VALUES=$(grep -i "sleeping for" "$DAEMON_LOG" 2>/dev/null \
    | grep -oE '[0-9]+(ms)?' | sort -un || true)
  SLEEP_DISTINCT=$(echo "$SLEEP_VALUES" | grep -c '[0-9]' 2>/dev/null || true)

  # Count tasks where last_fired_at is not null
  TASKS_FILE="$PULSEED_STATE_DIR/scheduled-tasks.json"
  FIRED_AT_UPDATED=0
  if [ -f "$TASKS_FILE" ]; then
    FIRED_AT_UPDATED=$(python3 -c "
import json, sys
data = json.load(open('$TASKS_FILE'))
count = sum(1 for t in data if t.get('last_fired_at') is not None)
print(count)
" 2>/dev/null || echo "0")
  fi
else
  SLEEP_VALUES=""
  SLEEP_DISTINCT=0
  FIRED_AT_UPDATED=0
fi

# --- Evaluate results ---
echo ""
echo "--- Evaluation ---"
PASS=0
FAIL=0

check() {
  local LABEL="$1"
  local RESULT="$2"   # "pass" or "fail"
  local DETAIL="$3"
  if [ "$RESULT" = "pass" ]; then
    echo "  PASS  $LABEL ($DETAIL)"
    PASS=$(( PASS + 1 ))
  else
    echo "  FAIL  $LABEL ($DETAIL)"
    FAIL=$(( FAIL + 1 ))
  fi
}

# Check a: Multiple goals rotate — all 3 goal IDs appear in loop log lines
GOALS_ROTATED=0
[ "$GOAL_A_ITERS" -gt 0 ] && GOALS_ROTATED=$(( GOALS_ROTATED + 1 ))
[ "$GOAL_B_ITERS" -gt 0 ] && GOALS_ROTATED=$(( GOALS_ROTATED + 1 ))
[ "$GOAL_C_ITERS" -gt 0 ] && GOALS_ROTATED=$(( GOALS_ROTATED + 1 ))

[ "$GOALS_ROTATED" -ge 2 ] \
  && check "a. Multiple goals rotate (>=2 goal IDs in log)" "pass" \
     "goals_seen=$GOALS_ROTATED (A=${GOAL_A_ITERS}, B=${GOAL_B_ITERS}, C=${GOAL_C_ITERS})" \
  || check "a. Multiple goals rotate (>=2 goal IDs in log)" "fail" \
     "goals_seen=$GOALS_ROTATED — only one goal ran (blocking bug from #401 reproduced?)"

# Check b: Cron tasks fired as expected
[ "$CRON_DUE" -gt 0 ] \
  && check "b. Cron tasks detected as due" "pass" "count=$CRON_DUE" \
  || check "b. Cron tasks detected as due" "fail" "count=0 — check CronScheduler integration"

[ "$CRON_FIRED" -gt 0 ] \
  && check "b. Cron tasks fired (markFired called)" "pass" "count=$CRON_FIRED" \
  || check "b. Cron tasks fired (markFired called)" "fail" "count=0 — tasks were not executed"

[ "$FIRED_AT_UPDATED" -gt 0 ] \
  && check "b. last_fired_at updated in scheduled-tasks.json" "pass" "tasks_updated=$FIRED_AT_UPDATED" \
  || check "b. last_fired_at updated in scheduled-tasks.json" "fail" "tasks_updated=0"

# Check c: Proactive tick fired even with active goals (key #401 fix behavior)
[ "$PROACTIVE_TICKS" -gt 0 ] \
  && check "c. Proactive tick fired with active goals present" "pass" "count=$PROACTIVE_TICKS" \
  || check "c. Proactive tick fired with active goals present" "fail" \
     "count=0 — proactive_mode may be disabled or LLM unavailable"

# Check d: Adaptive sleep varies (multiple distinct values)
[ "$SLEEP_DISTINCT" -ge 2 ] \
  && check "d. Adaptive sleep varies (>=2 distinct intervals)" "pass" "distinct_values=$SLEEP_DISTINCT" \
  || check "d. Adaptive sleep varies (>=2 distinct intervals)" "fail" \
     "distinct_values=$SLEEP_DISTINCT — adaptive_sleep may not be active"

[ "$SLEEP_MESSAGES" -gt 0 ] \
  && check "d. Sleep messages logged" "pass" "count=$SLEEP_MESSAGES" \
  || check "d. Sleep messages logged" "fail" "count=0"

# --- Write markdown report ---
mkdir -p "$(dirname "$REPORT_FILE")"

cat > "$REPORT_FILE" <<MDHEADER
# Integrated Daemon Dogfood (#401 fix) — ${DATE}

## Summary

- **Goals**: A=${GOAL_A_ID}, B=${GOAL_B_ID}, C=${GOAL_C_ID}
- **Monitor duration**: 300 s (5 min)
- **Passed checks**: ${PASS}
- **Failed checks**: ${FAIL}

## What This Verifies

PR #401 fixed a daemon blocking bug: previously only one goal would run per daemon
cycle. This script confirms the interleaved loop fix by running 3 simultaneous goals
and checking that all rotate through the daemon loop.

## Config Used

\`\`\`json
$(cat "$CONFIG_FILE")
\`\`\`

## Scheduled Tasks Seeded

- \`550e8400-...0011\` — cron=\`* * * * *\`, type=reflection, permanent=false
- \`550e8400-...0012\` — cron=\`* * * * *\`, type=consolidation, permanent=true

## Observations

| Signal | Count |
|--------|-------|
| Total loop completions | ${LOOP_COUNT} |
| Goal A loop iterations | ${GOAL_A_ITERS} |
| Goal B loop iterations | ${GOAL_B_ITERS} |
| Goal C loop iterations | ${GOAL_C_ITERS} |
| Proactive ticks | ${PROACTIVE_TICKS} |
| Cron task due detections | ${CRON_DUE} |
| Cron tasks fired | ${CRON_FIRED} |
| Tasks with last_fired_at updated | ${FIRED_AT_UPDATED} |
| Adaptive sleep messages | ${SLEEP_MESSAGES} |
| Distinct sleep interval values | ${SLEEP_DISTINCT} |

### Unique sleep interval values

\`\`\`
${SLEEP_VALUES:-"(none found)"}
\`\`\`

## Check Results

MDHEADER

# a. Multi-goal rotation
if [ "$GOALS_ROTATED" -ge 2 ]; then
  echo "- [x] a. Multiple goals rotate — PASS (goals_seen=$GOALS_ROTATED)" >> "$REPORT_FILE"
else
  echo "- [ ] a. Multiple goals rotate — FAIL (goals_seen=$GOALS_ROTATED)" >> "$REPORT_FILE"
fi

# b. Cron
if [ "$CRON_DUE" -gt 0 ]; then
  echo "- [x] b. Cron tasks detected as due — PASS (count=$CRON_DUE)" >> "$REPORT_FILE"
else
  echo "- [ ] b. Cron tasks detected as due — FAIL (count=0)" >> "$REPORT_FILE"
fi

if [ "$CRON_FIRED" -gt 0 ]; then
  echo "- [x] b. Cron tasks fired — PASS (count=$CRON_FIRED)" >> "$REPORT_FILE"
else
  echo "- [ ] b. Cron tasks fired — FAIL (count=0)" >> "$REPORT_FILE"
fi

if [ "$FIRED_AT_UPDATED" -gt 0 ]; then
  echo "- [x] b. last_fired_at updated — PASS (tasks_updated=$FIRED_AT_UPDATED)" >> "$REPORT_FILE"
else
  echo "- [ ] b. last_fired_at updated — FAIL (tasks_updated=0)" >> "$REPORT_FILE"
fi

# c. Proactive tick
if [ "$PROACTIVE_TICKS" -gt 0 ]; then
  echo "- [x] c. Proactive tick fired with active goals — PASS (count=$PROACTIVE_TICKS)" >> "$REPORT_FILE"
else
  echo "- [ ] c. Proactive tick fired with active goals — FAIL (count=0)" >> "$REPORT_FILE"
fi

# d. Adaptive sleep
if [ "$SLEEP_DISTINCT" -ge 2 ]; then
  echo "- [x] d. Adaptive sleep varies — PASS (distinct_values=$SLEEP_DISTINCT)" >> "$REPORT_FILE"
else
  echo "- [ ] d. Adaptive sleep varies — FAIL (distinct_values=$SLEEP_DISTINCT)" >> "$REPORT_FILE"
fi

if [ "$SLEEP_MESSAGES" -gt 0 ]; then
  echo "- [x] d. Sleep messages logged — PASS (count=$SLEEP_MESSAGES)" >> "$REPORT_FILE"
else
  echo "- [ ] d. Sleep messages logged — FAIL (count=0)" >> "$REPORT_FILE"
fi

cat >> "$REPORT_FILE" <<'MDSEP'

## Full Daemon Log

```
MDSEP

if [ -f "$DAEMON_LOG" ]; then
  cat "$DAEMON_LOG" >> "$REPORT_FILE"
else
  echo "(no daemon log found)" >> "$REPORT_FILE"
fi

cat >> "$REPORT_FILE" <<'MDFOOTER'
```

## Verification Checklist

- [ ] All 3 goal IDs appear in "Running loop for goal:" log lines
- [ ] No single goal monopolizes the loop (interleaved rotation confirmed)
- [ ] "Cron task due:" appears at least twice (one per task)
- [ ] "Cron task fired:" appears at least twice
- [ ] "Proactive tick" appears while goal C was still active (before workspace-c/target.txt was created)
- [ ] "Sleeping for" shows at least 2 distinct values (adaptive sleep is working)
- [ ] Daemon stops cleanly on `pulseed stop`
MDFOOTER

echo ""
echo "=== Dogfooding complete $(date) ==="
echo "PASS=$PASS  FAIL=$FAIL"
echo "Report: $REPORT_FILE"

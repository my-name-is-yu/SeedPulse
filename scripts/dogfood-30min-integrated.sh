#!/bin/bash
# 30-minute integrated dogfooding script — exercises ALL Phase A-C features together:
#   - Daemon mode with proactive_mode + adaptive_sleep
#   - Shell hooks for LoopCycleStart, PostObserve, PostExecute, GoalStateChange
#   - CronScheduler (reflection every 5 min, consolidation every 10 min)
#   - Multiple goals (3 goals with different dimensions)
# Run from project root: bash scripts/dogfood-30min-integrated.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PULSEED="node dist/cli-runner.js"
DATE="$(date +%Y-%m-%d)"
TMP_WORKSPACE="$(mktemp -d)"
# Isolated pulseed state dir — never touches ~/.pulseed
PULSEED_STATE_DIR="$TMP_WORKSPACE/pulseed-state"
HOOK_LOG="$TMP_WORKSPACE/hooks.log"
DAEMON_LOG="$TMP_WORKSPACE/daemon.log"
DAEMON_PID_FILE="$TMP_WORKSPACE/daemon.pid"
CONFIG_FILE="$TMP_WORKSPACE/daemon-config.json"
REPORT_FILE="$REPO_DIR/memory/dogfood-30min-integrated-${DATE}.md"
MEM_LOG="$TMP_WORKSPACE/memory.log"

export PULSEED_HOME="$PULSEED_STATE_DIR"

DAEMON_PID=""

# ─── Cleanup ───

cleanup() {
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo ""
    echo "Stopping daemon (PID $DAEMON_PID)..."
    PULSEED_HOME="$PULSEED_STATE_DIR" $PULSEED stop 2>/dev/null \
      || kill "$DAEMON_PID" 2>/dev/null || true
    sleep 2
  fi
  if [ -f "$DAEMON_PID_FILE" ]; then
    rm -f "$DAEMON_PID_FILE"
  fi
  if [ -d "$TMP_WORKSPACE" ]; then
    rm -rf "$TMP_WORKSPACE"
    echo "Cleaned up $TMP_WORKSPACE"
  fi
}
trap cleanup EXIT

echo "=== 30-Minute Integrated Dogfooding $(date) ==="
echo "Workspace:   $TMP_WORKSPACE"
echo "PulSeed dir: $PULSEED_STATE_DIR"
echo "Hook log:    $HOOK_LOG"
echo "Daemon log:  $DAEMON_LOG"
echo "Report:      $REPORT_FILE"

# ─── Build ───

echo ""
echo "--- Building project ---"
npm run build >/dev/null
echo "Build complete."

# ─── Create temp workspace ───

echo ""
echo "--- Creating temp workspace ---"
mkdir -p "$TMP_WORKSPACE/src" "$TMP_WORKSPACE/tests" "$PULSEED_STATE_DIR"

cat > "$TMP_WORKSPACE/package.json" <<'JSON'
{
  "name": "dogfood-integrated",
  "version": "0.1.0",
  "type": "module"
}
JSON

cat > "$TMP_WORKSPACE/src/calculator.ts" <<'TS'
// TODO: add input validation
// TODO: handle overflow
export function add(a: number, b: number): number {
  return a + b;
}
export function subtract(a: number, b: number): number {
  return a - b;
}
TS

cat > "$TMP_WORKSPACE/src/greeter.ts" <<'TS'
// TODO: support i18n
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
TS

# Seed a real test file so test_count:min:3 can be satisfied
cat > "$TMP_WORKSPACE/tests/calculator.test.ts" <<'TS'
import { add, subtract } from '../src/calculator.js';
// test 1
if (add(1, 2) !== 3) throw new Error('add failed');
// test 2
if (subtract(5, 3) !== 2) throw new Error('subtract failed');
// test 3
if (add(0, 0) !== 0) throw new Error('zero add failed');
// test 4
if (subtract(0, 1) !== -1) throw new Error('negative subtract failed');
TS

(cd "$TMP_WORKSPACE" && git init -q && git add -A && git commit -q -m "initial seed")
echo "Workspace seed files created (git initialized)."
echo "Initial state: 4 tests, 3 TODOs."

# ─── Daemon config ───

echo ""
echo "--- Creating daemon config ---"
cat > "$CONFIG_FILE" <<'JSON'
{
  "check_interval_ms": 30000,
  "proactive_mode": true,
  "proactive_interval_ms": 300000,
  "adaptive_sleep": {
    "enabled": true,
    "min_interval_ms": 15000,
    "max_interval_ms": 120000,
    "night_start_hour": 22,
    "night_end_hour": 7,
    "night_multiplier": 2.0
  }
}
JSON
echo "Daemon config written."

# ─── Install hooks (isolated into PULSEED_STATE_DIR) ───

echo ""
echo "--- Installing hooks ---"
# Clear hook log
> "$HOOK_LOG"

cat > "$PULSEED_STATE_DIR/hooks.json" <<HOOKSEOF
{
  "hooks": [
    {
      "event": "LoopCycleStart",
      "type": "shell",
      "command": "echo \"\$(date -u +%H:%M:%S) HOOK_FIRED: LoopCycleStart\" >> $HOOK_LOG",
      "timeout_ms": 5000,
      "enabled": true
    },
    {
      "event": "PostObserve",
      "type": "shell",
      "command": "echo \"\$(date -u +%H:%M:%S) HOOK_FIRED: PostObserve\" >> $HOOK_LOG",
      "timeout_ms": 5000,
      "enabled": true
    },
    {
      "event": "PostExecute",
      "type": "shell",
      "command": "echo \"\$(date -u +%H:%M:%S) HOOK_FIRED: PostExecute\" >> $HOOK_LOG",
      "timeout_ms": 5000,
      "enabled": true
    },
    {
      "event": "GoalStateChange",
      "type": "shell",
      "command": "echo \"\$(date -u +%H:%M:%S) HOOK_FIRED: GoalStateChange\" >> $HOOK_LOG",
      "timeout_ms": 5000,
      "enabled": true
    }
  ]
}
HOOKSEOF
echo "hooks.json installed in $PULSEED_STATE_DIR."

# ─── Seed scheduled tasks ───

echo ""
echo "--- Seeding scheduled tasks ---"
cat > "$PULSEED_STATE_DIR/scheduled-tasks.json" <<'JSON'
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440010",
    "cron": "*/5 * * * *",
    "prompt": "Reflect on recent test coverage changes and summarize progress",
    "type": "reflection",
    "enabled": true,
    "last_fired_at": null,
    "permanent": false,
    "created_at": "2026-04-01T00:00:00.000Z"
  },
  {
    "id": "550e8400-e29b-41d4-a716-446655440011",
    "cron": "*/10 * * * *",
    "prompt": "Consolidate recent observations and update knowledge base",
    "type": "consolidation",
    "enabled": true,
    "last_fired_at": null,
    "permanent": true,
    "created_at": "2026-04-01T00:00:00.000Z"
  }
]
JSON
echo "Scheduled tasks (reflection every 5 min, consolidation every 10 min) seeded."

# ─── Register goals ───

echo ""
echo "--- Registering goals ---"

# Goal A: achievable — workspace already has 4 tests, threshold is 3
GOAL_A_OUTPUT=$(PULSEED_HOME="$PULSEED_STATE_DIR" $PULSEED goal add \
  --title "Increase test coverage" \
  --dim "test_count:min:3" \
  --constraint "workspace_path:$TMP_WORKSPACE" 2>&1)
echo "$GOAL_A_OUTPUT"
GOAL_A=$(echo "$GOAL_A_OUTPUT" | grep "^Goal ID:" | awk '{print $NF}')
if [ -z "$GOAL_A" ]; then
  echo "ERROR: Failed to parse Goal A ID"
  exit 1
fi
echo "Goal A: $GOAL_A  (test_count:min:3 — achievable)"

# Goal B: achievable — workspace has 3 TODOs, threshold is max:1 (challenging but testable)
GOAL_B_OUTPUT=$(PULSEED_HOME="$PULSEED_STATE_DIR" $PULSEED goal add \
  --title "Reduce TODOs" \
  --dim "todo_count:max:1" \
  --constraint "workspace_path:$TMP_WORKSPACE" 2>&1)
echo "$GOAL_B_OUTPUT"
GOAL_B=$(echo "$GOAL_B_OUTPUT" | grep "^Goal ID:" | awk '{print $NF}')
if [ -z "$GOAL_B" ]; then
  echo "ERROR: Failed to parse Goal B ID"
  exit 1
fi
echo "Goal B: $GOAL_B  (todo_count:max:1 — achievable)"

# Goal C: trivial — test_count:max:999 is already met → completes fast → triggers proactive tick
GOAL_C_OUTPUT=$(PULSEED_HOME="$PULSEED_STATE_DIR" $PULSEED goal add \
  --title "Maintain code quality" \
  --dim "test_count:max:999" \
  --constraint "workspace_path:$TMP_WORKSPACE" 2>&1)
echo "$GOAL_C_OUTPUT"
GOAL_C=$(echo "$GOAL_C_OUTPUT" | grep "^Goal ID:" | awk '{print $NF}')
if [ -z "$GOAL_C" ]; then
  echo "ERROR: Failed to parse Goal C ID"
  exit 1
fi
echo "Goal C: $GOAL_C  (test_count:max:999 — trivial, completes fast)"

# ─── Start daemon ───

echo ""
echo "--- Starting daemon (30-minute run) ---"
PULSEED_HOME="$PULSEED_STATE_DIR" $PULSEED start \
  --goal "$GOAL_A" \
  --goal "$GOAL_B" \
  --goal "$GOAL_C" \
  --config "$CONFIG_FILE" \
  >"$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!
echo "$DAEMON_PID" > "$DAEMON_PID_FILE"
echo "Daemon started (PID $DAEMON_PID)"
echo "Logging to: $DAEMON_LOG"

# Give daemon a moment to initialise
sleep 3
if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
  echo "ERROR: Daemon exited immediately. Check $DAEMON_LOG"
  cat "$DAEMON_LOG" || true
  exit 1
fi
echo "Daemon alive — entering 30-minute monitor loop."

# ─── Monitor for 30 minutes ───

echo ""
echo "--- Monitoring (1800 seconds, polling every 30 s) ---"
echo "Live dashboard printed every 30 seconds."
echo ""

MONITOR_START=$(date +%s)
MONITOR_DURATION=1800   # 30 minutes
POLL_INTERVAL=30
MEM_SAMPLE_INTERVAL=300  # 5 minutes
LAST_MEM_SAMPLE=$MONITOR_START

while true; do
  NOW=$(date +%s)
  ELAPSED=$(( NOW - MONITOR_START ))

  if [ $ELAPSED -ge $MONITOR_DURATION ]; then
    echo ""
    echo "Monitor window complete (${MONITOR_DURATION}s)."
    break
  fi

  # Check daemon liveness
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo ""
    echo "WARNING: Daemon process exited early (PID $DAEMON_PID)"
    break
  fi

  # Sample memory every 5 minutes
  if [ $(( NOW - LAST_MEM_SAMPLE )) -ge $MEM_SAMPLE_INTERVAL ]; then
    RSS=$(ps -o rss= -p "$DAEMON_PID" 2>/dev/null || echo "0")
    echo "$(date -u +%H:%M:%S) MEM_SAMPLE: rss=${RSS}kB" >> "$MEM_LOG"
    LAST_MEM_SAMPLE=$NOW
  fi

  # Count signals from daemon log
  LOOP_ITERS=0
  PROACTIVE_TICKS=0
  SLEEP_MSGS=0
  CRON_DUE=0
  CRON_FIRED=0
  if [ -f "$DAEMON_LOG" ]; then
    LOOP_ITERS=$(grep -ci "running loop for goal\|observing\|generating task" "$DAEMON_LOG" 2>/dev/null || true)
    PROACTIVE_TICKS=$(grep -ci "proactive tick" "$DAEMON_LOG" 2>/dev/null || true)
    SLEEP_MSGS=$(grep -ci "sleeping for" "$DAEMON_LOG" 2>/dev/null || true)
    CRON_DUE=$(grep -c "Cron task due:" "$DAEMON_LOG" 2>/dev/null || true)
    CRON_FIRED=$(grep -c "Cron task fired:" "$DAEMON_LOG" 2>/dev/null || true)
  fi

  # Count hook fires
  HOOK_LOOP_CYCLE=0
  HOOK_POST_OBSERVE=0
  HOOK_POST_EXECUTE=0
  HOOK_GOAL_STATE=0
  if [ -f "$HOOK_LOG" ]; then
    HOOK_LOOP_CYCLE=$(grep -c "HOOK_FIRED: LoopCycleStart" "$HOOK_LOG" 2>/dev/null || true)
    HOOK_POST_OBSERVE=$(grep -c "HOOK_FIRED: PostObserve" "$HOOK_LOG" 2>/dev/null || true)
    HOOK_POST_EXECUTE=$(grep -c "HOOK_FIRED: PostExecute" "$HOOK_LOG" 2>/dev/null || true)
    HOOK_GOAL_STATE=$(grep -c "HOOK_FIRED: GoalStateChange" "$HOOK_LOG" 2>/dev/null || true)
  fi

  # Goals completed (look for "completed" or "satisfied" in daemon log)
  GOALS_DONE=$(grep -ci "goal.*complet\|status.*satisfied\|satisficed" "$DAEMON_LOG" 2>/dev/null || true)

  # Format elapsed as MM:SS
  ELAPSED_MM=$(( ELAPSED / 60 ))
  ELAPSED_SS=$(( ELAPSED % 60 ))
  printf "\r[%02d:%02d] loops=%-4s proactive=%-3s sleep=%-3s cron_due=%-3s cron_fired=%-3s | hooks: loop=%-3s obs=%-3s exec=%-3s state=%-3s | goals_done=%-3s" \
    "$ELAPSED_MM" "$ELAPSED_SS" \
    "$LOOP_ITERS" "$PROACTIVE_TICKS" "$SLEEP_MSGS" \
    "$CRON_DUE" "$CRON_FIRED" \
    "$HOOK_LOOP_CYCLE" "$HOOK_POST_OBSERVE" "$HOOK_POST_EXECUTE" "$HOOK_GOAL_STATE" \
    "$GOALS_DONE"

  sleep "$POLL_INTERVAL"
done
echo ""

# ─── Stop daemon ───

echo ""
echo "--- Stopping daemon ---"
PULSEED_HOME="$PULSEED_STATE_DIR" $PULSEED stop 2>/dev/null || {
  echo "stop command failed; sending SIGTERM to $DAEMON_PID"
  kill "$DAEMON_PID" 2>/dev/null || true
}
sleep 3
DAEMON_PID=""  # Mark as stopped so cleanup() doesn't double-kill
rm -f "$DAEMON_PID_FILE"

# ─── Final counts ───

echo ""
echo "--- Collecting final counts ---"

LOOP_ITERS=0
PROACTIVE_TICKS=0
SLEEP_MSGS=0
CRON_DUE=0
CRON_FIRED=0
if [ -f "$DAEMON_LOG" ]; then
  LOOP_ITERS=$(grep -ci "running loop for goal\|observing\|generating task" "$DAEMON_LOG" 2>/dev/null || true)
  PROACTIVE_TICKS=$(grep -ci "proactive tick" "$DAEMON_LOG" 2>/dev/null || true)
  SLEEP_MSGS=$(grep -ci "sleeping for" "$DAEMON_LOG" 2>/dev/null || true)
  CRON_DUE=$(grep -c "Cron task due:" "$DAEMON_LOG" 2>/dev/null || true)
  CRON_FIRED=$(grep -c "Cron task fired:" "$DAEMON_LOG" 2>/dev/null || true)
fi

HOOK_LOOP_CYCLE=0
HOOK_POST_OBSERVE=0
HOOK_POST_EXECUTE=0
HOOK_GOAL_STATE=0
if [ -f "$HOOK_LOG" ]; then
  HOOK_LOOP_CYCLE=$(grep -c "HOOK_FIRED: LoopCycleStart" "$HOOK_LOG" 2>/dev/null || true)
  HOOK_POST_OBSERVE=$(grep -c "HOOK_FIRED: PostObserve" "$HOOK_LOG" 2>/dev/null || true)
  HOOK_POST_EXECUTE=$(grep -c "HOOK_FIRED: PostExecute" "$HOOK_LOG" 2>/dev/null || true)
  HOOK_GOAL_STATE=$(grep -c "HOOK_FIRED: GoalStateChange" "$HOOK_LOG" 2>/dev/null || true)
fi

# Check last_fired_at was updated in scheduled-tasks.json
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

# Memory usage summary
MEM_SAMPLES=""
if [ -f "$MEM_LOG" ]; then
  MEM_SAMPLES=$(cat "$MEM_LOG")
fi

echo "Loop iterations   : $LOOP_ITERS"
echo "Proactive ticks   : $PROACTIVE_TICKS"
echo "Sleep messages    : $SLEEP_MSGS"
echo "Cron due          : $CRON_DUE"
echo "Cron fired        : $CRON_FIRED"
echo "Tasks updated     : $FIRED_AT_UPDATED"
echo "Hook LoopCycleStart : $HOOK_LOOP_CYCLE"
echo "Hook PostObserve  : $HOOK_POST_OBSERVE"
echo "Hook PostExecute  : $HOOK_POST_EXECUTE"
echo "Hook GoalStateChange: $HOOK_GOAL_STATE"

# ─── Evaluate ───

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

info() {
  echo "  INFO  $1 ($2)"
}

# Daemon ran
[ "$LOOP_ITERS" -ge 10 ] \
  && check "Loop ran >= 10 iterations" "pass" "count=$LOOP_ITERS" \
  || check "Loop ran >= 10 iterations" "fail" "count=$LOOP_ITERS — expected >= 10 in 30 min"

# Hooks fired
[ "$HOOK_LOOP_CYCLE" -ge 1 ] \
  && check "LoopCycleStart hooks fired" "pass" "count=$HOOK_LOOP_CYCLE" \
  || check "LoopCycleStart hooks fired" "fail" "count=0"

[ "$HOOK_POST_OBSERVE" -ge 1 ] \
  && check "PostObserve hooks fired" "pass" "count=$HOOK_POST_OBSERVE" \
  || check "PostObserve hooks fired" "fail" "count=0"

[ "$HOOK_GOAL_STATE" -ge 1 ] \
  && check "GoalStateChange fired (>= 1 goal completed)" "pass" "count=$HOOK_GOAL_STATE" \
  || check "GoalStateChange fired (>= 1 goal completed)" "fail" "count=0 — Goal C should complete quickly"

# Cron
[ "$CRON_FIRED" -ge 4 ] \
  && check "Cron tasks fired >= 4 (5-min task x4 in 30 min)" "pass" "cron_fired=$CRON_FIRED" \
  || check "Cron tasks fired >= 4 (5-min task x4 in 30 min)" "fail" "cron_fired=$CRON_FIRED"

# Proactive
[ "$PROACTIVE_TICKS" -ge 1 ] \
  && check "Proactive ticks fired (>= 1 after Goal C completes)" "pass" "count=$PROACTIVE_TICKS" \
  || check "Proactive ticks fired (>= 1 after Goal C completes)" "fail" "count=0"

# Adaptive sleep
[ "$SLEEP_MSGS" -ge 1 ] \
  && check "Adaptive sleep messages logged" "pass" "count=$SLEEP_MSGS" \
  || check "Adaptive sleep messages logged" "fail" "count=0"

# Info-only
info "PostExecute hooks" "count=$HOOK_POST_EXECUTE"
info "Cron tasks detected as due" "count=$CRON_DUE"
info "scheduled-tasks.json last_fired_at updated" "tasks=$FIRED_AT_UPDATED"

# ─── Write report ───

echo ""
echo "--- Writing markdown report ---"
mkdir -p "$(dirname "$REPORT_FILE")"

HOOK_LOG_CONTENTS="(not found)"
if [ -f "$HOOK_LOG" ]; then
  HOOK_LOG_CONTENTS=$(cat "$HOOK_LOG")
fi

SLEEP_VALUES="(none found)"
if [ -f "$DAEMON_LOG" ]; then
  SLEEP_VALUES=$(grep -i "sleeping for" "$DAEMON_LOG" 2>/dev/null \
    | grep -oE '[0-9]+(ms)?' | sort -un | head -20 || true)
  SLEEP_VALUES="${SLEEP_VALUES:-"(none found)"}"
fi

cat > "$REPORT_FILE" <<MDHEADER
# 30-Minute Integrated Dogfood — ${DATE}

## Summary

- **Goals**: A=\`${GOAL_A}\`, B=\`${GOAL_B}\`, C=\`${GOAL_C}\`
- **Monitor duration**: 1800 s (30 minutes)
- **Passed checks**: ${PASS}
- **Failed checks**: ${FAIL}
- **Overall result**: $([ "$FAIL" -eq 0 ] && echo "PASS" || echo "FAIL")

## Features Under Test

| Feature | Config |
|---------|--------|
| Daemon mode | check_interval_ms=30000 |
| Proactive mode | enabled, proactive_interval_ms=300000 |
| Adaptive sleep | min=15000ms, max=120000ms, night_multiplier=2.0 |
| Hooks | LoopCycleStart, PostObserve, PostExecute, GoalStateChange |
| CronScheduler | reflection every 5 min, consolidation every 10 min |
| Goal A | test_count:min:3 (achievable) |
| Goal B | todo_count:max:1 (challenging) |
| Goal C | test_count:max:999 (trivial — triggers proactive) |

## Daemon Config

\`\`\`json
$(cat "$CONFIG_FILE")
\`\`\`

## Metrics

| Signal | Count |
|--------|-------|
| Loop iterations | ${LOOP_ITERS} |
| Proactive ticks | ${PROACTIVE_TICKS} |
| Adaptive sleep messages | ${SLEEP_MSGS} |
| Cron task due (log lines) | ${CRON_DUE} |
| Cron task fired (log lines) | ${CRON_FIRED} |
| scheduled-tasks.json updated | ${FIRED_AT_UPDATED} |
| Hook: LoopCycleStart | ${HOOK_LOOP_CYCLE} |
| Hook: PostObserve | ${HOOK_POST_OBSERVE} |
| Hook: PostExecute | ${HOOK_POST_EXECUTE} |
| Hook: GoalStateChange | ${HOOK_GOAL_STATE} |

## Check Results

MDHEADER

# Append check results
[ "$LOOP_ITERS" -ge 10 ] \
  && echo "- [x] Loop ran >= 10 iterations (count=$LOOP_ITERS)" >> "$REPORT_FILE" \
  || echo "- [ ] Loop ran >= 10 iterations — FAIL (count=$LOOP_ITERS)" >> "$REPORT_FILE"

[ "$HOOK_LOOP_CYCLE" -ge 1 ] \
  && echo "- [x] LoopCycleStart hooks fired (count=$HOOK_LOOP_CYCLE)" >> "$REPORT_FILE" \
  || echo "- [ ] LoopCycleStart hooks fired — FAIL (count=0)" >> "$REPORT_FILE"

[ "$HOOK_POST_OBSERVE" -ge 1 ] \
  && echo "- [x] PostObserve hooks fired (count=$HOOK_POST_OBSERVE)" >> "$REPORT_FILE" \
  || echo "- [ ] PostObserve hooks fired — FAIL (count=0)" >> "$REPORT_FILE"

[ "$HOOK_GOAL_STATE" -ge 1 ] \
  && echo "- [x] GoalStateChange fired (count=$HOOK_GOAL_STATE)" >> "$REPORT_FILE" \
  || echo "- [ ] GoalStateChange fired — FAIL (count=0)" >> "$REPORT_FILE"

[ "$CRON_FIRED" -ge 4 ] \
  && echo "- [x] Cron tasks fired >= 4 (cron_fired=$CRON_FIRED)" >> "$REPORT_FILE" \
  || echo "- [ ] Cron tasks fired >= 4 — FAIL (cron_fired=$CRON_FIRED)" >> "$REPORT_FILE"

[ "$PROACTIVE_TICKS" -ge 1 ] \
  && echo "- [x] Proactive ticks fired (count=$PROACTIVE_TICKS)" >> "$REPORT_FILE" \
  || echo "- [ ] Proactive ticks fired — FAIL (count=0)" >> "$REPORT_FILE"

[ "$SLEEP_MSGS" -ge 1 ] \
  && echo "- [x] Adaptive sleep messages logged (count=$SLEEP_MSGS)" >> "$REPORT_FILE" \
  || echo "- [ ] Adaptive sleep messages logged — FAIL (count=0)" >> "$REPORT_FILE"

echo "- INFO  PostExecute hooks count: ${HOOK_POST_EXECUTE}" >> "$REPORT_FILE"
echo "- INFO  Cron tasks detected as due: ${CRON_DUE}" >> "$REPORT_FILE"
echo "- INFO  scheduled-tasks.json tasks updated: ${FIRED_AT_UPDATED}" >> "$REPORT_FILE"

cat >> "$REPORT_FILE" <<MDSEC

## Memory Usage Samples (every 5 min)

\`\`\`
${MEM_SAMPLES:-"(no samples)"}
\`\`\`

## Unique Adaptive Sleep Intervals

\`\`\`
${SLEEP_VALUES}
\`\`\`

## Hook Log

\`\`\`
MDSEC

echo "$HOOK_LOG_CONTENTS" >> "$REPORT_FILE"

cat >> "$REPORT_FILE" <<'MDSEP'
```

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

- [ ] LoopCycleStart fires at least once per daemon cycle
- [ ] PostObserve fires after each observation
- [ ] GoalStateChange fires when Goal C completes (trivial goal)
- [ ] Cron reflection task fires at ~5-minute intervals (>= 4 fires in 30 min)
- [ ] Cron consolidation task fires at ~10-minute intervals (>= 2 fires in 30 min)
- [ ] Proactive tick fires after all goals are satisfied (especially after Goal C)
- [ ] Adaptive sleep intervals stay within [15000, 120000] ms bounds
- [ ] Night-hours multiplier applied if run between 22:00–07:00
- [ ] Daemon stops cleanly on `pulseed stop`
- [ ] Memory usage remains stable (no unbounded growth across 30 min)
MDFOOTER

echo ""
echo "=== Dogfooding complete $(date) ==="
echo "PASS=$PASS  FAIL=$FAIL"
echo "Report: $REPORT_FILE"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

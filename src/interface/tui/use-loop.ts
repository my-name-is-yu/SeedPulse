import { useState, useEffect, useRef, useCallback } from "react";
import type { CoreLoop, LoopResult } from "../../orchestrator/loop/core-loop.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { TrustManager } from "../../platform/traits/trust-manager.js";
import type { Threshold } from "../../base/types/core.js";
import type { DaemonClient } from "../../runtime/daemon-client.js";

export interface LoopState {
  running: boolean;
  goalId: string | null;
  iteration: number;
  /** "idle" | "running" | "completed" | "stalled" | "error" | "stopped" | "max_iterations" */
  status: string;
  dimensions: DimensionProgress[];
  trustScore: number;
  startedAt: string | null;
  lastResult: LoopResult | null;
  lastError?: string;
}

export interface DimensionProgress {
  name: string;
  displayName: string;
  currentValue: unknown;
  threshold: unknown;
  progress: number; // 0-100
}

// ─── Progress Calculation ───

/**
 * Calculate 0-100 progress for a single dimension based on its threshold type
 * and current_value.
 */
export function calcDimensionProgress(
  currentValue: unknown,
  threshold: Threshold
): number {
  if (currentValue === null || currentValue === undefined) {
    return 0;
  }

  switch (threshold.type) {
    case "present": {
      const truthy =
        currentValue !== false &&
        currentValue !== 0 &&
        currentValue !== "" &&
        currentValue !== null;
      return truthy ? 100 : 0;
    }
    case "match": {
      return currentValue === threshold.value ? 100 : 0;
    }
    case "min": {
      const cur = toNum(currentValue);
      if (threshold.value === 0) return cur >= 0 ? 100 : 0;
      return Math.min(100, Math.max(0, Math.round((cur / threshold.value) * 100)));
    }
    case "max": {
      const cur = toNum(currentValue);
      // For max thresholds: being at or below the target is 100%.
      // Being over the target reduces progress.
      if (cur <= threshold.value) return 100;
      if (threshold.value === 0) return 0;
      // Clamp: once current is 2x target, treat as 0%
      const excess = cur - threshold.value;
      return Math.max(0, Math.round((1 - excess / threshold.value) * 100));
    }
    case "range": {
      const cur = toNum(currentValue);
      return cur >= threshold.low && cur <= threshold.high ? 100 : 0;
    }
  }
}

function toNum(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

// ─── LoopController ───

const POLL_INTERVAL_MS = 2000;

export class LoopController {
  private state: LoopState;
  private onUpdate: ((state: LoopState) => void) | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  // Nullable to support daemon mode where these are not needed in-process
  private coreLoop: CoreLoop | null;
  private stateManager: StateManager;
  private trustManager: TrustManager | null;

  // Daemon mode fields
  private daemonClient: DaemonClient | null = null;
  private sseHandlers: Map<string, (data: unknown) => void> = new Map();

  constructor(
    coreLoop: CoreLoop | null,
    stateManager: StateManager,
    trustManager: TrustManager | null,
    daemonClient?: DaemonClient,
  ) {
    this.coreLoop = coreLoop;
    this.stateManager = stateManager;
    this.trustManager = trustManager;
    this.daemonClient = daemonClient ?? null;
    this.state = {
      running: false,
      goalId: null,
      iteration: 0,
      status: "idle",
      dimensions: [],
      trustScore: 0,
      startedAt: null,
      lastResult: null,
    };
  }

  get isDaemonMode(): boolean {
    return this.daemonClient !== null;
  }

  getState(): LoopState {
    return this.state;
  }

  setOnUpdate(cb: ((state: LoopState) => void) | null): void {
    this.onUpdate = cb;
  }

  async start(goalId: string): Promise<void> {
    if (this.state.running) return;

    this.setState({
      running: true,
      goalId,
      iteration: 0,
      status: "running",
      startedAt: new Date().toISOString(),
      lastResult: null,
    });

    if (this.daemonClient) {
      // Daemon mode: delegate start to daemon, receive updates via SSE
      await this.daemonClient.startGoal(goalId);
      this.subscribeToDaemonEvents(goalId);
      // Poll for dimension data (SSE does not carry full state)
      this.pollInterval = setInterval(() => {
        if (this.state.goalId) {
          void this.refreshState(this.state.goalId);
        }
      }, POLL_INTERVAL_MS);
    } else if (this.coreLoop) {
      // Standalone mode: existing behavior
      await this.refreshState(goalId);
      this.pollInterval = setInterval(() => {
        if (this.state.goalId) {
          void this.refreshState(this.state.goalId);
        }
      }, POLL_INTERVAL_MS);

      this.coreLoop.run(goalId).then((result) => {
        this.cleanup();
        this.setState({
          running: false,
          status: result.finalStatus,
          iteration: result.totalIterations,
          lastResult: result,
        });
        void this.refreshState(goalId);
      }).catch((err: unknown) => {
        this.cleanup();
        const msg = err instanceof Error ? err.message : String(err);
        this.setState({
          running: false,
          status: "error",
          lastResult: null,
          lastError: msg,
        });
      });
    }
  }

  stop(): void {
    if (this.daemonClient && this.state.goalId) {
      this.daemonClient.stopGoal(this.state.goalId).catch(() => {});
    } else if (this.coreLoop) {
      this.coreLoop.stop();
    }
    this.cleanup();
    this.setState({ running: false, status: "stopped", goalId: null });
  }

  async refreshState(goalId: string): Promise<void> {
    const goal = await this.stateManager.loadGoal(goalId);
    if (!goal) return;

    const dimensions: DimensionProgress[] = goal.dimensions.map((dim) => ({
      name: dim.name,
      displayName: dim.label,
      currentValue: dim.current_value,
      threshold: dim.threshold,
      progress: calcDimensionProgress(dim.current_value, dim.threshold),
    }));

    const trustScore = this.trustManager
      ? (await this.trustManager.getBalance(goalId)).balance
      : 0;

    this.setState({ dimensions, trustScore });
  }

  // ─── Private ───

  private subscribeToDaemonEvents(goalId: string): void {
    if (!this.daemonClient) return;

    const onIterationComplete = (data: unknown) => {
      const d = data as { goalId: string; loopCount: number; status: string };
      if (d.goalId === goalId) {
        this.setState({ iteration: d.loopCount });
        void this.refreshState(goalId);
      }
    };

    const onGoalUpdated = (data: unknown) => {
      const d = data as { goalId: string; status: string };
      if (d.goalId === goalId) {
        if (d.status === "completed" || d.status === "satisfied") {
          this.cleanup();
          this.setState({ running: false, status: d.status });
        }
        void this.refreshState(goalId);
      }
    };

    const onDaemonStatus = (data: unknown) => {
      const d = data as { activeGoals: string[] };
      if (d.activeGoals && !d.activeGoals.includes(goalId)) {
        this.setState({ running: false, status: "stopped" });
      }
    };

    this.daemonClient.on("iteration_complete", onIterationComplete);
    this.daemonClient.on("goal_updated", onGoalUpdated);
    this.daemonClient.on("daemon_status", onDaemonStatus);

    this.sseHandlers.set("iteration_complete", onIterationComplete);
    this.sseHandlers.set("goal_updated", onGoalUpdated);
    this.sseHandlers.set("daemon_status", onDaemonStatus);
  }

  private cleanup(): void {
    if (this.pollInterval !== null) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.daemonClient) {
      for (const [event, handler] of this.sseHandlers) {
        this.daemonClient.off(event, handler);
      }
      this.sseHandlers.clear();
    }
  }

  private setState(partial: Partial<LoopState>): void {
    this.state = { ...this.state, ...partial };
    if (this.onUpdate) {
      this.onUpdate(this.state);
    }
  }
}

// ─── useLoop hook ───
//
// React hook that wraps LoopController and exposes loop state + control
// functions directly to React components. Eliminates the need to pass a
// LoopController instance as a prop from entry.ts into App.
//
// Supports both standalone mode (coreLoop provided) and daemon mode
// (daemonClient provided). In daemon mode, start() delegates to the daemon
// via REST and receives state updates via SSE events.
//
// Usage:
//   const { loopState, start, stop, getController } = useLoop(coreLoop, stateManager, trustManager);
//   const { loopState, start, stop, getController } = useLoop(null, stateManager, null, daemonClient);

export interface UseLoopResult {
  loopState: LoopState;
  start: (goalId: string) => void;
  stop: () => void;
  /** Register a callback that will be invoked whenever a LoopController
   *  onUpdate notification would have fired (used by entry.ts approval wiring). */
  getController: () => LoopController;
}

export function useLoop(
  coreLoop: CoreLoop | null,
  stateManager: StateManager,
  trustManager: TrustManager | null,
  daemonClient?: DaemonClient,
): UseLoopResult {
  // Stable controller reference — created once per mount
  const controllerRef = useRef<LoopController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new LoopController(coreLoop, stateManager, trustManager, daemonClient);
  }
  const controller = controllerRef.current;

  const [loopState, setLoopState] = useState<LoopState>(() => controller.getState());

  useEffect(() => {
    controller.setOnUpdate(setLoopState);
    return () => {
      controller.setOnUpdate(null);
      controller.stop();
    };
  }, [controller]);

  const start = useCallback(
    (goalId: string) => {
      void controller.start(goalId);
    },
    [controller]
  );

  const stop = useCallback(() => {
    controller.stop();
  }, [controller]);

  const getController = useCallback(() => controller, [controller]);

  return { loopState, start, stop, getController };
}

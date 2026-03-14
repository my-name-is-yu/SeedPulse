import * as fs from "node:fs";
import * as path from "node:path";
import { GoalSchema, GoalTreeSchema } from "./types/goal.js";
import { ObservationLogSchema, ObservationLogEntrySchema } from "./types/state.js";
import { GapHistoryEntrySchema } from "./types/gap.js";
import type { Goal, GoalTree } from "./types/goal.js";
import type { ObservationLog, ObservationLogEntry } from "./types/state.js";
import type { RescheduleOptions } from "./types/state.js";
import type { GapHistoryEntry } from "./types/gap.js";
import type { PaceSnapshot } from "./types/goal.js";

/**
 * StateManager handles persistence of goals, state vectors, observation logs,
 * and gap history under a base directory (default: ~/.motiva/).
 *
 * File layout:
 *   <base>/goals/<goal_id>/goal.json
 *   <base>/goals/<goal_id>/observations.json
 *   <base>/goals/<goal_id>/gap-history.json
 *   <base>/goal-trees/<root_id>.json
 *   <base>/events/              (event queue directory)
 *   <base>/events/archive/      (processed events)
 *   <base>/reports/             (report output directory)
 *
 * All writes are atomic: write to .tmp file, then rename.
 */
export class StateManager {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(process.env.HOME ?? "~", ".motiva");
    this.ensureDirectories();
  }

  /** Returns the base directory path */
  getBaseDir(): string {
    return this.baseDir;
  }

  // ─── Directory Management ───

  private ensureDirectories(): void {
    const dirs = [
      this.baseDir,
      path.join(this.baseDir, "goals"),
      path.join(this.baseDir, "goal-trees"),
      path.join(this.baseDir, "events"),
      path.join(this.baseDir, "events", "archive"),
      path.join(this.baseDir, "reports"),
      path.join(this.baseDir, "reports", "daily"),
      path.join(this.baseDir, "reports", "weekly"),
      path.join(this.baseDir, "reports", "notifications"),
    ];
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private goalDir(goalId: string): string {
    const dir = path.join(this.baseDir, "goals", goalId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ─── Atomic Write ───

  private atomicWrite(filePath: string, data: unknown): void {
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  }

  private readJsonFile<T>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as T;
  }

  // ─── Goal CRUD ───

  saveGoal(goal: Goal): void {
    const parsed = GoalSchema.parse(goal);
    const dir = this.goalDir(parsed.id);
    this.atomicWrite(path.join(dir, "goal.json"), parsed);
  }

  loadGoal(goalId: string): Goal | null {
    const filePath = path.join(this.baseDir, "goals", goalId, "goal.json");
    const raw = this.readJsonFile<unknown>(filePath);
    if (raw === null) return null;
    return GoalSchema.parse(raw);
  }

  deleteGoal(goalId: string): boolean {
    const dir = path.join(this.baseDir, "goals", goalId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  listGoalIds(): string[] {
    const goalsDir = path.join(this.baseDir, "goals");
    if (!fs.existsSync(goalsDir)) return [];
    return fs
      .readdirSync(goalsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  // ─── Goal Tree ───

  saveGoalTree(tree: GoalTree): void {
    const parsed = GoalTreeSchema.parse(tree);
    const filePath = path.join(
      this.baseDir,
      "goal-trees",
      `${parsed.root_id}.json`
    );
    this.atomicWrite(filePath, parsed);
  }

  loadGoalTree(rootId: string): GoalTree | null {
    const filePath = path.join(this.baseDir, "goal-trees", `${rootId}.json`);
    const raw = this.readJsonFile<unknown>(filePath);
    if (raw === null) return null;
    return GoalTreeSchema.parse(raw);
  }

  deleteGoalTree(rootId: string): boolean {
    const filePath = path.join(this.baseDir, "goal-trees", `${rootId}.json`);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  // ─── Observation Log ───

  saveObservationLog(log: ObservationLog): void {
    const parsed = ObservationLogSchema.parse(log);
    const dir = this.goalDir(parsed.goal_id);
    this.atomicWrite(path.join(dir, "observations.json"), parsed);
  }

  loadObservationLog(goalId: string): ObservationLog | null {
    const filePath = path.join(
      this.baseDir,
      "goals",
      goalId,
      "observations.json"
    );
    const raw = this.readJsonFile<unknown>(filePath);
    if (raw === null) return null;
    return ObservationLogSchema.parse(raw);
  }

  appendObservation(goalId: string, entry: ObservationLogEntry): void {
    const parsed = ObservationLogEntrySchema.parse(entry);
    if (parsed.goal_id !== goalId) {
      throw new Error(
        `appendObservation: entry.goal_id ("${parsed.goal_id}") does not match goalId ("${goalId}")`
      );
    }
    let log = this.loadObservationLog(goalId);
    if (log === null) {
      log = { goal_id: goalId, entries: [] };
    }
    log.entries.push(parsed);
    this.saveObservationLog(log);
  }

  // ─── Gap History ───

  saveGapHistory(goalId: string, history: GapHistoryEntry[]): void {
    const parsed = history.map((e) => GapHistoryEntrySchema.parse(e));
    const dir = this.goalDir(goalId);
    this.atomicWrite(path.join(dir, "gap-history.json"), parsed);
  }

  loadGapHistory(goalId: string): GapHistoryEntry[] {
    const filePath = path.join(
      this.baseDir,
      "goals",
      goalId,
      "gap-history.json"
    );
    const raw = this.readJsonFile<unknown[]>(filePath);
    if (raw === null) return [];
    return raw.map((e) => GapHistoryEntrySchema.parse(e));
  }

  appendGapHistoryEntry(goalId: string, entry: GapHistoryEntry): void {
    const parsed = GapHistoryEntrySchema.parse(entry);
    const history = this.loadGapHistory(goalId);
    history.push(parsed);
    this.saveGapHistory(goalId, history);
  }

  // ─── Milestone Tracking ───

  /**
   * Returns all goals with node_type === "milestone".
   */
  getMilestones(goals: Goal[]): Goal[] {
    return goals.filter((g) => g.node_type === "milestone");
  }

  /**
   * Returns milestones whose target_date is in the past (overdue).
   * Goals without a target_date are excluded.
   */
  getOverdueMilestones(goals: Goal[]): Goal[] {
    const now = new Date();
    return this.getMilestones(goals).filter((g) => {
      if (!g.target_date) return false;
      return new Date(g.target_date) < now;
    });
  }

  /**
   * Evaluate pace for a milestone goal.
   * currentAchievement (0-1) is computed by the caller (e.g. from SatisficingJudge).
   *
   * Pace evaluation logic (state-vector.md §8):
   *   elapsed_ratio = time_elapsed / total_duration   (creation → target_date)
   *   achievement_ratio = currentAchievement          (0-1)
   *   pace_ratio = achievement_ratio / elapsed_ratio  (guard divide-by-zero)
   *   on_track: pace_ratio >= 0.8
   *   at_risk:  pace_ratio >= 0.5
   *   behind:   pace_ratio < 0.5
   *
   * If no target_date is set, returns on_track with pace_ratio = 1.
   */
  evaluatePace(milestone: Goal, currentAchievement: number): PaceSnapshot {
    const now = new Date();
    const evaluatedAt = now.toISOString();

    if (!milestone.target_date) {
      return {
        elapsed_ratio: 0,
        achievement_ratio: currentAchievement,
        pace_ratio: 1,
        status: "on_track",
        evaluated_at: evaluatedAt,
      };
    }

    const createdAt = new Date(milestone.created_at).getTime();
    const targetDate = new Date(milestone.target_date).getTime();
    const totalDuration = targetDate - createdAt;

    // If total_duration is 0 or negative (target_date <= created_at), treat as elapsed
    if (totalDuration <= 0) {
      const paceRatio = currentAchievement;
      const status = paceRatio >= 0.8 ? "on_track" : paceRatio >= 0.5 ? "at_risk" : "behind";
      return {
        elapsed_ratio: 1,
        achievement_ratio: currentAchievement,
        pace_ratio: paceRatio,
        status,
        evaluated_at: evaluatedAt,
      };
    }

    const elapsed = now.getTime() - createdAt;
    const elapsedRatio = Math.min(elapsed / totalDuration, 1);

    let paceRatio: number;
    if (elapsedRatio === 0) {
      // No time elapsed yet — treat as on_track
      paceRatio = 1;
    } else {
      paceRatio = currentAchievement / elapsedRatio;
    }

    const status =
      paceRatio >= 0.8 ? "on_track" : paceRatio >= 0.5 ? "at_risk" : "behind";

    return {
      elapsed_ratio: elapsedRatio,
      achievement_ratio: currentAchievement,
      pace_ratio: paceRatio,
      status,
      evaluated_at: evaluatedAt,
    };
  }

  /**
   * Save a pace snapshot to a milestone goal (persists to disk).
   */
  async savePaceSnapshot(goalId: string, snapshot: PaceSnapshot): Promise<void> {
    const goal = this.loadGoal(goalId);
    if (!goal) {
      throw new Error(`savePaceSnapshot: goal "${goalId}" not found`);
    }
    const updated: Goal = { ...goal, pace_snapshot: snapshot };
    this.saveGoal(updated);
  }

  /**
   * Generate reschedule options when a milestone is behind.
   * Always returns 3 options: extend_deadline, reduce_target, renegotiate.
   */
  generateRescheduleOptions(milestone: Goal, currentAchievement: number): RescheduleOptions {
    const snapshot = this.evaluatePace(milestone, currentAchievement);
    const now = new Date();

    // Extend deadline: add half the remaining duration
    let extendedDate: string | null = null;
    if (milestone.target_date) {
      const targetMs = new Date(milestone.target_date).getTime();
      const createdMs = new Date(milestone.created_at).getTime();
      const totalDuration = targetMs - createdMs;
      const halfDuration = Math.max(totalDuration * 0.5, 7 * 24 * 60 * 60 * 1000); // at least 7 days
      extendedDate = new Date(targetMs + halfDuration).toISOString();
    }

    // Reduce target: scale current threshold by currentAchievement + buffer
    let reducedTargetValue: number | null = null;
    const firstNumericDim = milestone.dimensions.find(
      (d) => typeof d.current_value === "number" && d.threshold.type === "min"
    );
    if (firstNumericDim && firstNumericDim.threshold.type === "min") {
      const originalTarget = firstNumericDim.threshold.value;
      reducedTargetValue = Math.round(originalTarget * Math.max(currentAchievement + 0.1, 0.5));
    }

    return {
      milestone_id: milestone.id,
      goal_id: milestone.parent_id ?? milestone.id,
      current_pace: snapshot.status,
      options: [
        {
          option_type: "extend_deadline",
          description: `Extend the deadline to give more time to reach the original target`,
          new_target_date: extendedDate,
          new_target_value: null,
        },
        {
          option_type: "reduce_target",
          description: `Lower the target value to match current pace`,
          new_target_date: null,
          new_target_value: reducedTargetValue,
        },
        {
          option_type: "renegotiate",
          description: `Trigger full goal renegotiation to reassess feasibility`,
          new_target_date: null,
          new_target_value: null,
        },
      ],
      generated_at: now.toISOString(),
    };
  }

  // ─── Utility ───

  /** Check whether a goal directory exists */
  goalExists(goalId: string): boolean {
    return fs.existsSync(
      path.join(this.baseDir, "goals", goalId, "goal.json")
    );
  }

  /** Read raw JSON from any path relative to base dir */
  readRaw(relativePath: string): unknown | null {
    const filePath = path.join(this.baseDir, relativePath);
    return this.readJsonFile<unknown>(filePath);
  }

  /** Write raw JSON to any path relative to base dir (atomic) */
  writeRaw(relativePath: string, data: unknown): void {
    const filePath = path.join(this.baseDir, relativePath);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    this.atomicWrite(filePath, data);
  }
}

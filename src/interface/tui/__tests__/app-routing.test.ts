import { describe, expect, it } from "vitest";
import {
  deriveDaemonGoalIdFromActiveGoals,
  isChatRunnerOwnedSlashCommand,
  resolveFreeformInputRoute,
} from "../app.js";

describe("TUI app routing helpers", () => {
  it("keeps free-form input on ChatRunner when daemon has an active goal", () => {
    expect(resolveFreeformInputRoute({
      isDaemonMode: true,
      daemonGoalId: "goal-1",
      hasChatRunner: true,
    })).toBe("chat_runner");
  });

  it("falls back to daemon goal chat only when ChatRunner is unavailable", () => {
    expect(resolveFreeformInputRoute({
      isDaemonMode: true,
      daemonGoalId: "goal-1",
      hasChatRunner: false,
    })).toBe("daemon_goal_chat");
  });

  it("recognizes ChatRunner-owned slash commands from the TUI surface", () => {
    expect(isChatRunnerOwnedSlashCommand("/resume Work Session")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/sessions")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/history saved")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/compact")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/tend")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/permissions read-only")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/start goal-1")).toBe(false);
  });

  it("derives and clears displayed daemon goal from activeGoals", () => {
    expect(deriveDaemonGoalIdFromActiveGoals("goal-2", ["goal-1", "goal-2"])).toBe("goal-2");
    expect(deriveDaemonGoalIdFromActiveGoals("stale-goal", ["goal-1"])).toBe("goal-1");
    expect(deriveDaemonGoalIdFromActiveGoals("stale-goal", [])).toBeNull();
  });
});

import type { StateManager } from "../../../base/state/state-manager.js";
import type { Task } from "../../../base/types/task.js";
export { verifyExecutionWithGitDiff } from "./task-execution-helpers.js";

export async function reloadTaskFromDisk(stateManager: StateManager, task: Task): Promise<Task> {
  const fresh = await stateManager.loadTask(task.goal_id, task.id);
  return fresh ?? task;
}

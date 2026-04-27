import { randomUUID } from "node:crypto";
import type { Task } from "../../base/types/task.js";
import type { ApprovalRequest } from "./app.js";

export function createApprovalQueue() {
  let requestApproval: ((req: ApprovalRequest) => void) | null = null;
  const pendingApprovals: ApprovalRequest[] = [];

  const enqueueApproval = (task: Task): Promise<boolean> => {
    return new Promise((resolve) => {
      const request = { task, resolve };
      if (requestApproval) {
        requestApproval(request);
      } else {
        pendingApprovals.push(request);
      }
    });
  };

  return {
    enqueueApproval,
    setRequestApproval(fn: (req: ApprovalRequest) => void) {
      requestApproval = fn;
      while (pendingApprovals.length > 0) {
        const pending = pendingApprovals.shift();
        if (pending) {
          requestApproval(pending);
        }
      }
    },
  };
}

export function createChatToolApprovalTask(description: string): Task {
  return {
    id: randomUUID(),
    goal_id: "chat-tool-approval",
    strategy_id: null,
    target_dimensions: ["approval"],
    primary_dimension: "approval",
    work_description: description,
    rationale: "Requested by chat tool execution",
    approach: "Wait for explicit approval before continuing the chat tool call.",
    success_criteria: [],
    scope_boundary: {
      in_scope: ["Approve or reject the pending chat tool action."],
      out_of_scope: ["Execute any work beyond the requested chat tool action."],
      blast_radius: "Limited to whether the pending chat tool call proceeds.",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "unknown",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
  };
}

import type { VerificationFileDiff } from "../base/types/task.js";

export type ExecutionSummaryParams = {
  goalId: string;
  loopIndex: number;
  observation: { dimensionName: string; progress: number; confidence: number }[];
  gapAggregate: number;
  taskResult: {
    taskId: string;
    action: string;
    dimension: string;
    verificationDiffs?: VerificationFileDiff[];
  } | null;
  stallDetected: boolean;
  pivotOccurred: boolean;
  elapsedMs: number;
};

export type NotificationType =
  | "urgent"
  | "approval_required"
  | "stall_escalation"
  | "completed"
  | "capability_insufficient";

export type NotificationContext = {
  goalId: string;
  message: string;
  details?: string;
};

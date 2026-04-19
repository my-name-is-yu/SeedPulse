import { randomUUID } from 'node:crypto';
import type { CoreLoop } from '../../orchestrator/loop/core-loop.js';
import type { LoopResult } from '../../orchestrator/loop/core-loop.js';

export interface GoalWorkerConfig {
  iterationsPerCycle: number; // default 5
}

export type WorkerStatus = 'idle' | 'running' | 'crashed';

export interface WorkerResult {
  goalId: string;
  status: 'completed' | 'stalled' | 'max_iterations' | 'error' | 'stopped';
  totalIterations: number;
  durationMs: number;
  error?: string;
}

function toWorkerStatus(finalStatus: LoopResult['finalStatus']): WorkerResult['status'] {
  return finalStatus;
}

export class GoalWorker {
  readonly id: string;
  private status: WorkerStatus = 'idle';
  private currentGoalId: string | null = null;
  private startedAt: number = 0;
  private currentIterations: number = 0;
  private extendRequested: boolean = false;

  constructor(
    private readonly coreLoop: CoreLoop,
    private readonly config: GoalWorkerConfig = { iterationsPerCycle: 5 },
    private readonly hooks?: {
      onRunComplete?: (result: LoopResult, cumulativeIterations: number) => Promise<void> | void;
    }
  ) {
    this.id = randomUUID();
  }

  async execute(goalId: string): Promise<WorkerResult> {
    this.status = 'running';
    this.currentGoalId = goalId;
    this.startedAt = Date.now();
    this.currentIterations = 0;
    this.extendRequested = false;

    try {
      let lastResult: LoopResult | undefined;
      let cumulativeIterations = 0;
      do {
        this.extendRequested = false;
        lastResult = await this.coreLoop.run(goalId, {
          maxIterations: this.config.iterationsPerCycle,
        });
        cumulativeIterations += lastResult.totalIterations;
        this.currentIterations = cumulativeIterations;
        try {
          await this.hooks?.onRunComplete?.(lastResult, cumulativeIterations);
        } catch {
          // Bookkeeping callbacks must not turn a successful loop into a worker crash.
        }

        if (!this.extendRequested) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } while (this.extendRequested);

      this.status = 'idle';
      return {
        goalId,
        status: toWorkerStatus(lastResult.finalStatus),
        totalIterations: cumulativeIterations,
        durationMs: Date.now() - this.startedAt,
        error: lastResult.errorMessage,
      };
    } catch (err) {
      this.status = 'crashed';
      return {
        goalId,
        status: 'error',
        totalIterations: 0,
        durationMs: Date.now() - this.startedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.currentGoalId = null;
      this.currentIterations = 0;
      if (this.status === 'running') {
        this.status = 'idle';
      }
    }
  }

  requestExtend(): void {
    this.extendRequested = true;
  }

  getStatus(): WorkerStatus {
    return this.status;
  }

  getCurrentGoalId(): string | null {
    return this.currentGoalId;
  }

  getStartedAt(): number {
    return this.startedAt;
  }

  getIterations(): number {
    return this.currentIterations;
  }

  isIdle(): boolean {
    return this.status === 'idle';
  }
}

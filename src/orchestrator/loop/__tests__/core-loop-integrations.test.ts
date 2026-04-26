import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CoreLoop,
  type CoreLoopDeps,
  type GapCalculatorModule,
  type DriveScorerModule,
  type ReportingEngine,
} from "../core-loop.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { ObservationEngine } from "../../../platform/observation/observation-engine.js";
import {
  TaskLifecycle as RealTaskLifecycle,
  type TaskLifecycle,
  type TaskCycleResult,
} from "../../execution/task/task-lifecycle.js";
import type { SatisficingJudge } from "../../../platform/drive/satisficing-judge.js";
import {
  StallDetector as RealStallDetector,
  type StallDetector,
} from "../../../platform/drive/stall-detector.js";
import {
  StrategyManager as RealStrategyManager,
  type StrategyManager,
} from "../../strategy/strategy-manager.js";
import type { DriveSystem } from "../../../platform/drive/drive-system.js";
import type { AdapterRegistry, IAdapter } from "../../execution/adapter-layer.js";
import type { GapVector } from "../../../base/types/gap.js";
import type { CompletionJudgment } from "../../../base/types/satisficing.js";
import type { StallReport } from "../../../base/types/stall.js";
import type { DriveScore } from "../../../base/types/drive.js";
import { saveDreamConfig } from "../../../platform/dream/dream-config.js";
import { SessionManager } from "../../execution/session-manager.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { ReportingEngine as RealReportingEngine } from "../../../reporting/reporting-engine.js";
import { CapabilityDetector } from "../../../platform/observation/capability-detector.js";
import { ApprovalStore } from "../../../runtime/store/approval-store.js";
import { WaitDeadlineResolver, getDueWaitGoalIds } from "../../../runtime/daemon/wait-deadline-resolver.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { makeDimension, makeGoal } from "../../../../tests/helpers/fixtures.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";

function makeGapVector(goalId = "goal-1"): GapVector {
  return {
    goal_id: goalId,
    gaps: [
      {
        dimension_name: "dim1",
        raw_gap: 5,
        normalized_gap: 0.5,
        normalized_weighted_gap: 0.5,
        confidence: 0.8,
        uncertainty_weight: 1.0,
      },
      {
        dimension_name: "dim2",
        raw_gap: 5,
        normalized_gap: 0.625,
        normalized_weighted_gap: 0.625,
        confidence: 0.7,
        uncertainty_weight: 1.0,
      },
    ],
    timestamp: new Date().toISOString(),
  };
}

function makeDriveScores(): DriveScore[] {
  return [
    {
      dimension_name: "dim1",
      dissatisfaction: 0.5,
      deadline: 0,
      opportunity: 0,
      final_score: 0.5,
      dominant_drive: "dissatisfaction",
    },
    {
      dimension_name: "dim2",
      dissatisfaction: 0.625,
      deadline: 0,
      opportunity: 0,
      final_score: 0.625,
      dominant_drive: "dissatisfaction",
    },
  ];
}

function makeCompletionJudgment(
  overrides: Partial<CompletionJudgment> = {}
): CompletionJudgment {
  return {
    is_complete: false,
    blocking_dimensions: ["dim1", "dim2"],
    low_confidence_dimensions: [],
    needs_verification_task: false,
    checked_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeTaskCycleResult(
  overrides: Partial<TaskCycleResult> = {}
): TaskCycleResult {
  return {
    task: {
      id: "task-1",
      goal_id: "goal-1",
      strategy_id: null,
      target_dimensions: ["dim1"],
      primary_dimension: "dim1",
      work_description: "Test task",
      rationale: "Test rationale",
      approach: "Test approach",
      success_criteria: [
        {
          description: "Test criterion",
          verification_method: "manual check",
          is_blocking: true,
        },
      ],
      scope_boundary: {
        in_scope: ["test"],
        out_of_scope: [],
        blast_radius: "none",
      },
      constraints: [],
      plateau_until: null,
      estimated_duration: null,
      consecutive_failure_count: 0,
      reversibility: "reversible",
      task_category: "normal",
      status: "completed",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      timeout_at: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
    },
    verificationResult: {
      task_id: "task-1",
      verdict: "pass",
      confidence: 0.9,
      evidence: [
        {
          layer: "mechanical",
          description: "Pass",
          confidence: 0.9,
        },
      ],
      dimension_updates: [],
      timestamp: new Date().toISOString(),
    },
    action: "completed",
    ...overrides,
  };
}

function makeStallReport(overrides: Partial<StallReport> = {}): StallReport {
  return {
    stall_type: "dimension_stall",
    goal_id: "goal-1",
    dimension_name: "dim1",
    task_id: null,
    detected_at: new Date().toISOString(),
    escalation_level: 0,
    suggested_cause: "approach_failure",
    decay_factor: 0.6,
    ...overrides,
  };
}

function makeGeneratedTaskResponse(): string {
  return JSON.stringify({
    work_description: "Deploy the service to production",
    rationale: "The goal requires production deployment to close the gap",
    approach: "Run the production deployment workflow",
    success_criteria: [
      {
        description: "Production deployment has completed",
        verification_method: "manual check",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["production deployment"],
      out_of_scope: ["unrelated infrastructure changes"],
      blast_radius: "production service",
    },
    constraints: ["requires explicit deployment permission"],
    reversibility: "reversible",
    estimated_duration: { value: 30, unit: "minutes" },
  });
}

function createMockAdapter(): IAdapter {
  return {
    adapterType: "openai_codex_cli",
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: "Task completed",
      error: null,
      exit_code: null,
      elapsed_ms: 1000,
      stopped_reason: "completed",
    }),
  };
}

function createMockDeps(tmpDir: string): {
  deps: CoreLoopDeps;
  mocks: {
    stateManager: StateManager;
    observationEngine: Record<string, ReturnType<typeof vi.fn>>;
    gapCalculator: Record<string, ReturnType<typeof vi.fn>>;
    driveScorer: Record<string, ReturnType<typeof vi.fn>>;
    taskLifecycle: Record<string, ReturnType<typeof vi.fn>>;
    satisficingJudge: Record<string, ReturnType<typeof vi.fn>>;
    stallDetector: Record<string, ReturnType<typeof vi.fn>>;
    strategyManager: Record<string, ReturnType<typeof vi.fn>>;
    reportingEngine: Record<string, ReturnType<typeof vi.fn>>;
    driveSystem: Record<string, ReturnType<typeof vi.fn>>;
    adapterRegistry: Record<string, ReturnType<typeof vi.fn>>;
    adapter: IAdapter;
  };
} {
  const stateManager = new StateManager(tmpDir);

  const adapter = createMockAdapter();

  const observationEngine = {
    observe: vi.fn(),
    applyObservation: vi.fn(),
    createObservationEntry: vi.fn(),
    getObservationLog: vi.fn(),
    saveObservationLog: vi.fn(),
    applyProgressCeiling: vi.fn(),
    getConfidenceTier: vi.fn(),
    resolveContradiction: vi.fn(),
    needsVerificationTask: vi.fn(),
  };

  const gapCalculator = {
    calculateGapVector: vi.fn().mockReturnValue(makeGapVector()),
    aggregateGaps: vi.fn().mockReturnValue(0.625),
  };

  const driveScorer = {
    scoreAllDimensions: vi.fn().mockReturnValue(makeDriveScores()),
    rankDimensions: vi.fn().mockImplementation((scores: DriveScore[]) =>
      [...scores].sort((a, b) => b.final_score - a.final_score)
    ),
  };

  const taskLifecycle = {
    runTaskCycle: vi.fn().mockResolvedValue(makeTaskCycleResult()),
    selectTargetDimension: vi.fn(),
    generateTask: vi.fn(),
    checkIrreversibleApproval: vi.fn(),
    executeTask: vi.fn(),
    verifyTask: vi.fn(),
    handleVerdict: vi.fn(),
    handleFailure: vi.fn(),
  };

  const satisficingJudge = {
    isGoalComplete: vi.fn().mockReturnValue(makeCompletionJudgment()),
    isDimensionSatisfied: vi.fn(),
    applyProgressCeiling: vi.fn(),
    selectDimensionsForIteration: vi.fn(),
    detectThresholdAdjustmentNeeded: vi.fn(),
    propagateSubgoalCompletion: vi.fn(),
  };

  const stallDetector = {
    checkDimensionStall: vi.fn().mockReturnValue(null),
    checkGlobalStall: vi.fn().mockReturnValue(null),
    checkTimeExceeded: vi.fn().mockReturnValue(null),
    checkConsecutiveFailures: vi.fn().mockReturnValue(null),
    getEscalationLevel: vi.fn().mockReturnValue(0),
    incrementEscalation: vi.fn().mockReturnValue(1),
    resetEscalation: vi.fn(),
    getStallState: vi.fn(),
    saveStallState: vi.fn(),
    classifyStallCause: vi.fn(),
    computeDecayFactor: vi.fn(),
    isSuppressed: vi.fn(),
  };

  const strategyManager = {
    onStallDetected: vi.fn().mockResolvedValue(null),
    getActiveStrategy: vi.fn().mockReturnValue(null),
    getPortfolio: vi.fn(),
    generateCandidates: vi.fn(),
    activateBestCandidate: vi.fn(),
    updateState: vi.fn(),
    getStrategyHistory: vi.fn(),
  };

  const reportingEngine = {
    generateExecutionSummary: vi.fn().mockReturnValue({ type: "execution_summary" }),
    saveReport: vi.fn(),
  };

  const driveSystem = {
    shouldActivate: vi.fn().mockReturnValue(true),
    processEvents: vi.fn().mockReturnValue([]),
    readEventQueue: vi.fn().mockReturnValue([]),
    archiveEvent: vi.fn(),
    getSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    isScheduleDue: vi.fn(),
    createDefaultSchedule: vi.fn(),
    prioritizeGoals: vi.fn(),
  };

  const adapterRegistry = {
    getAdapter: vi.fn().mockReturnValue(adapter),
    register: vi.fn(),
    listAdapters: vi.fn().mockReturnValue(["openai_codex_cli"]),
  };

  const deps: CoreLoopDeps = {
    stateManager,
    observationEngine: observationEngine as unknown as ObservationEngine,
    gapCalculator: gapCalculator as unknown as GapCalculatorModule,
    driveScorer: driveScorer as unknown as DriveScorerModule,
    taskLifecycle: taskLifecycle as unknown as TaskLifecycle,
    satisficingJudge: satisficingJudge as unknown as SatisficingJudge,
    stallDetector: stallDetector as unknown as StallDetector,
    strategyManager: strategyManager as unknown as StrategyManager,
    reportingEngine: reportingEngine as unknown as ReportingEngine,
    driveSystem: driveSystem as unknown as DriveSystem,
    adapterRegistry: adapterRegistry as unknown as AdapterRegistry,
  };

  return {
    deps,
    mocks: {
      stateManager,
      observationEngine,
      gapCalculator,
      driveScorer,
      taskLifecycle,
      satisficingJudge,
      stallDetector,
      strategyManager,
      reportingEngine,
      driveSystem,
      adapterRegistry,
      adapter,
    },
  };
}

// ─── Tests ───

describe("CoreLoop", async () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
  });

  // ─── KnowledgeManager integration ───

  describe("KnowledgeManager integration", async () => {
    function makeAcquisitionTask() {
      return {
        id: "acq-task-1",
        goal_id: "goal-1",
        strategy_id: null,
        target_dimensions: [],
        primary_dimension: "knowledge",
        work_description: "Research task: missing knowledge",
        rationale: "Knowledge gap detected",
        approach: "Research questions",
        success_criteria: [
          {
            description: "All questions answered",
            verification_method: "Manual review",
            is_blocking: true,
          },
        ],
        scope_boundary: {
          in_scope: ["Information collection"],
          out_of_scope: ["System modifications"],
          blast_radius: "None — read-only research task",
        },
        constraints: ["No system modifications allowed"],
        plateau_until: null,
        estimated_duration: { value: 4, unit: "hours" as const },
        consecutive_failure_count: 0,
        reversibility: "reversible" as const,
        task_category: "knowledge_acquisition" as const,
        status: "pending" as const,
        started_at: null,
        completed_at: null,
        timeout_at: null,
        heartbeat_at: null,
        created_at: new Date().toISOString(),
      };
    }

    it("generates acquisition task when knowledge gap detected", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const gapSignal = {
        signal_type: "interpretation_difficulty" as const,
        missing_knowledge: "Unknown domain",
        source_step: "gap_recognition",
        related_dimension: null,
      };

      const acquisitionTask = makeAcquisitionTask();

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue(gapSignal),
        generateAcquisitionTask: vi.fn().mockResolvedValue(acquisitionTask),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };

      const depsWithKM = { ...deps, knowledgeManager: knowledgeManager as any };
      const loop = new CoreLoop(depsWithKM, { delayBetweenLoopsMs: 0, adapterType: "test_adapter" as any });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(knowledgeManager.detectKnowledgeGap).toHaveBeenCalledOnce();
      expect(knowledgeManager.generateAcquisitionTask).toHaveBeenCalledWith(gapSignal, "goal-1");
      // runTaskCycle should NOT have been called — early return with acquisition task
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
      expect(result.taskResult).not.toBeNull();
      expect(result.taskResult?.task.task_category).toBe("knowledge_acquisition");
      expect(result.taskResult?.action).toBe("completed");
    });

    it("proceeds with normal task cycle when no knowledge gap detected", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue(null),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };

      const depsWithKM = { ...deps, knowledgeManager: knowledgeManager as any };
      const loop = new CoreLoop(depsWithKM, { delayBetweenLoopsMs: 0, adapterType: "test_adapter" as any });
      await loop.runOneIteration("goal-1", 0);

      expect(knowledgeManager.detectKnowledgeGap).toHaveBeenCalledOnce();
      expect(knowledgeManager.generateAcquisitionTask).not.toHaveBeenCalled();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("skips knowledge-gap diversion for workspace-backed code goals", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal({
        constraints: [`workspace_path:${tmpDir}`],
      }));

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue({
          signal_type: "interpretation_difficulty" as const,
          missing_knowledge: "Unknown domain",
          source_step: "gap_recognition",
          related_dimension: null,
        }),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };

      const depsWithKM = { ...deps, knowledgeManager: knowledgeManager as any };
      const loop = new CoreLoop(depsWithKM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(knowledgeManager.detectKnowledgeGap).not.toHaveBeenCalled();
      expect(knowledgeManager.generateAcquisitionTask).not.toHaveBeenCalled();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("injects relevant knowledge into task generation context", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const knowledgeEntries = [
        {
          entry_id: "e1",
          question: "What is the auth pattern?",
          answer: "JWT tokens",
          sources: [],
          confidence: 0.9,
          acquired_at: new Date().toISOString(),
          acquisition_task_id: "t1",
          superseded_by: null,
          tags: ["dim2"],
        },
      ];

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue(null),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue(knowledgeEntries),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue(knowledgeEntries),
        checkContradiction: vi.fn(),
      };

      const depsWithKM = { ...deps, knowledgeManager: knowledgeManager as any };
      const loop = new CoreLoop(depsWithKM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(knowledgeManager.getRelevantKnowledge).toHaveBeenCalledWith("goal-1", expect.any(String));
      // runTaskCycle should receive knowledgeContext as the 5th argument
      const callArgs = mocks.taskLifecycle.runTaskCycle.mock.calls[0];
      expect(callArgs![4]).toContain("JWT tokens");
    });

    it("adds cross-goal lessons when activation flag is enabled", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      await saveDreamConfig({
        activation: {
          semanticWorkingMemory: false,
          crossGoalLessons: true,
          semanticContext: false,
          autoAcquireKnowledge: false,
          learnedPatternHints: false,
          playbookHints: false,
          workflowHints: false,
          strategyTemplates: false,
          decisionHeuristics: false,
          graphTraversal: false,
        },
      }, mocks.stateManager.getBaseDir());

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue(null),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        searchKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };
      const memoryLifecycleManager = {
        searchCrossGoalLessons: vi.fn().mockResolvedValue([
          { lesson: "Reuse the migration checklist before touching schemas" },
        ]),
        selectForWorkingMemoryTierAware: vi.fn().mockResolvedValue({ shortTerm: [], lessons: [] }),
        onSatisficingJudgment: vi.fn(),
      };

      const loop = new CoreLoop(
        { ...deps, knowledgeManager: knowledgeManager as any, memoryLifecycleManager: memoryLifecycleManager as any },
        { delayBetweenLoopsMs: 0 }
      );
      const result = await loop.runOneIteration("goal-1", 1);

      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
      const callArgs = mocks.taskLifecycle.runTaskCycle.mock.calls[0];
      expect(callArgs![4]).toContain("Cross-goal lessons");
      expect(callArgs![4]).toContain("migration checklist");
    });

    it("skips knowledge injection gracefully when getRelevantKnowledge returns empty", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue(null),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };

      const depsWithKM = { ...deps, knowledgeManager: knowledgeManager as any };
      const loop = new CoreLoop(depsWithKM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      const callArgs = mocks.taskLifecycle.runTaskCycle.mock.calls[0];
      // knowledgeContext should be undefined when no entries found
      expect(callArgs![4]).toBeUndefined();
    });

    it("continues normally when knowledgeManager is undefined", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      // No knowledgeManager in deps
      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("non-fatal: continues when detectKnowledgeGap throws", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockRejectedValue(new Error("LLM failure")),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };

      const depsWithKM = { ...deps, knowledgeManager: knowledgeManager as any };
      const loop = new CoreLoop(depsWithKM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      // Should fall through to normal task cycle
      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("auto-acquires knowledge and skips execution when enabled and stalled", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      await saveDreamConfig({
        activation: {
          semanticWorkingMemory: false,
          crossGoalLessons: false,
          semanticContext: false,
          autoAcquireKnowledge: true,
          learnedPatternHints: false,
          playbookHints: false,
          workflowHints: false,
          strategyTemplates: false,
          decisionHeuristics: false,
          graphTraversal: false,
        },
      }, mocks.stateManager.getBaseDir());
      mocks.stallDetector.checkDimensionStall.mockReturnValue({
        stall_type: "plateau",
        confidence: 0.9,
        escalation_level: 1,
        suggested_cause: "information_deficit",
      });

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue({
          signal_type: "stall_information_deficit",
          missing_knowledge: "Need database migration constraints",
          source_step: "stall_detection",
          related_dimension: "dim1",
        }),
        generateAcquisitionTask: vi.fn(),
        acquireWithTools: vi.fn().mockResolvedValue([
          {
            entry_id: "k-1",
            question: "Need database migration constraints",
            answer: "Run schema diff before applying migrations",
            sources: [],
            confidence: 0.8,
            acquired_at: new Date().toISOString(),
            acquisition_task_id: "tool_direct",
            superseded_by: null,
            tags: ["db"],
            embedding_id: null,
          },
        ]),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        searchKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };
      const toolExecutor = { executeBatch: vi.fn() };

      const hookManager = {
        emit: vi.fn().mockResolvedValue(undefined),
        getDreamCollector: vi.fn(),
      };
      const loop = new CoreLoop(
        { ...deps, knowledgeManager: knowledgeManager as any, toolExecutor: toolExecutor as any, hookManager: hookManager as any },
        { delayBetweenLoopsMs: 0 }
      );
      const result = await loop.runOneIteration("goal-1", 1);

      expect(result.error).toBeNull();
      expect(result.stallDetected).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("dream_auto_acquire_knowledge");
      expect(knowledgeManager.acquireWithTools).toHaveBeenCalledOnce();
      expect(knowledgeManager.saveKnowledge).toHaveBeenCalledOnce();
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
      expect(hookManager.emit).toHaveBeenCalledWith("StallDetected", expect.any(Object));
    });
  });

  // ─── CapabilityDetector integration ───

  describe("CapabilityDetector integration", async () => {
    it("contract: real TaskLifecycle turns a detected permission gap into CoreLoop escalation", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const llmClient = createMockLLMClient([
        "```json\n" + makeGeneratedTaskResponse() + "\n```",
        JSON.stringify({
          has_deficiency: true,
          missing_capability: {
            name: "Production deployment approval",
            type: "permission",
          },
          reason: "Deploying this service requires explicit production approval.",
          alternatives: ["Request approval from the operator"],
          impact_description: "The deployment task cannot proceed safely without approval.",
        }),
      ]);
      const sessionManager = new SessionManager(mocks.stateManager);
      const trustManager = new TrustManager(mocks.stateManager);
      const stallDetector = new RealStallDetector(mocks.stateManager);
      const strategyManager = new RealStrategyManager(mocks.stateManager, llmClient);
      const reportingEngine = new RealReportingEngine(mocks.stateManager);
      const capabilityDetector = new CapabilityDetector(
        mocks.stateManager,
        llmClient,
        reportingEngine
      );
      const taskLifecycle = new RealTaskLifecycle(
        mocks.stateManager,
        llmClient,
        sessionManager,
        trustManager,
        strategyManager,
        stallDetector,
        {
          approvalFn: async () => true,
          capabilityDetector,
          healthCheckEnabled: false,
        }
      );

      const loop = new CoreLoop(
        {
          ...deps,
          taskLifecycle,
          stallDetector,
          strategyManager,
          reportingEngine,
          capabilityDetector,
        },
        { delayBetweenLoopsMs: 0 }
      );
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toBeNull();
      expect(result.taskResult?.action).toBe("escalate");
      expect(result.taskResult?.verificationResult.evidence[0]?.description).toContain(
        "Capability deficiency: Production deployment approval"
      );
      expect(mocks.adapter.execute).not.toHaveBeenCalled();
      expect(llmClient.callCount).toBe(2);
    });

    it("delegates capability detection to TaskLifecycle when capabilityDetector provided and deficiency detected", async () => {
      // Capability detection is handled inside TaskLifecycle.runTaskCycle, not CoreLoop.
      // CoreLoop must still call runTaskCycle and return whatever result TaskLifecycle produces.
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const escalateResult = makeTaskCycleResult({ action: "escalate" });
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(escalateResult);

      const capabilityDetector = {
        detectDeficiency: vi.fn(),
        escalateToUser: vi.fn(),
        loadRegistry: vi.fn(),
        saveRegistry: vi.fn(),
        registerCapability: vi.fn(),
        confirmDeficiency: vi.fn(),
      };

      const depsWithCD = { ...deps, capabilityDetector: capabilityDetector as any };
      const loop = new CoreLoop(depsWithCD, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      // CoreLoop must delegate to runTaskCycle — capability detection is TaskLifecycle's concern
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
      // CoreLoop must NOT call detectDeficiency directly (avoids duplicate calls + orphan tasks)
      expect(capabilityDetector.detectDeficiency).not.toHaveBeenCalled();
      expect(result.taskResult?.action).toBe("escalate");
    });

    it("proceeds with runTaskCycle when capabilityDetector provided and no deficiency", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const capabilityDetector = {
        detectDeficiency: vi.fn(),
        escalateToUser: vi.fn(),
        loadRegistry: vi.fn(),
        saveRegistry: vi.fn(),
        registerCapability: vi.fn(),
        confirmDeficiency: vi.fn(),
      };

      const depsWithCD = { ...deps, capabilityDetector: capabilityDetector as any };
      const loop = new CoreLoop(depsWithCD, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      // CoreLoop delegates to runTaskCycle; capability detection is inside TaskLifecycle
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
      expect(capabilityDetector.detectDeficiency).not.toHaveBeenCalled();
      expect(capabilityDetector.escalateToUser).not.toHaveBeenCalled();
    });

    it("continues normally when capabilityDetector is undefined", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("always calls runTaskCycle even when capabilityDetector is present", async () => {
      // CoreLoop no longer calls detectDeficiency directly — TaskLifecycle owns that.
      // Verify CoreLoop always reaches runTaskCycle regardless of capabilityDetector presence.
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const capabilityDetector = {
        detectDeficiency: vi.fn(),
        escalateToUser: vi.fn(),
        loadRegistry: vi.fn(),
        saveRegistry: vi.fn(),
        registerCapability: vi.fn(),
        confirmDeficiency: vi.fn(),
      };

      const depsWithCD = { ...deps, capabilityDetector: capabilityDetector as any };
      const loop = new CoreLoop(depsWithCD, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });
  });

  // ─── PortfolioManager integration ───

  describe("PortfolioManager integration", async () => {
    function createMockPortfolioManager() {
      return {
        selectNextStrategyForTask: vi.fn().mockReturnValue(null),
        recordTaskCompletion: vi.fn(),
        shouldRebalance: vi.fn().mockReturnValue(null),
        rebalance: vi.fn().mockReturnValue({ triggered_by: "periodic", adjustments: [], new_generation_needed: false, timestamp: new Date().toISOString() }),
        isWaitStrategy: vi.fn().mockReturnValue(false),
        handleWaitStrategyExpiry: vi.fn().mockReturnValue(null),
        getRebalanceHistory: vi.fn().mockReturnValue([]),
      };
    }

    it("works without portfolioManager (backward compat)", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      // deps has no portfolioManager
      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("calls selectNextStrategyForTask when portfolioManager provided", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const portfolioManager = createMockPortfolioManager();
      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.selectNextStrategyForTask).toHaveBeenCalledWith("goal-1");
    });

    it("calls setOnTaskComplete when selectNextStrategyForTask returns a result", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const selectionResult = { strategy_id: "strategy-1", allocation: 0.6 };
      const portfolioManager = createMockPortfolioManager();
      portfolioManager.selectNextStrategyForTask.mockReturnValue(selectionResult);

      // Add setOnTaskComplete to taskLifecycle mock
      mocks.taskLifecycle.setOnTaskComplete = vi.fn();

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.taskLifecycle.setOnTaskComplete).toHaveBeenCalledWith(expect.any(Function));
    });

    it("calls recordTaskCompletion after task completion when strategy_id present", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      // Task result has a strategy_id
      const taskResultWithStrategy = makeTaskCycleResult({
        action: "completed",
        task: {
          ...makeTaskCycleResult().task,
          strategy_id: "strategy-abc",
        },
      });
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(taskResultWithStrategy);

      const portfolioManager = createMockPortfolioManager();
      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.recordTaskCompletion).toHaveBeenCalledWith("strategy-abc");
    });

    it("does not call recordTaskCompletion when task action is not completed", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const taskResultKeep = makeTaskCycleResult({
        action: "keep",
        task: {
          ...makeTaskCycleResult().task,
          strategy_id: "strategy-abc",
        },
      });
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(taskResultKeep);

      const portfolioManager = createMockPortfolioManager();
      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.recordTaskCompletion).not.toHaveBeenCalled();
    });

    it("checks shouldRebalance after stall detection", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.stallDetector.checkDimensionStall.mockReturnValue(makeStallReport());

      const portfolioManager = createMockPortfolioManager();
      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.shouldRebalance).toHaveBeenCalledWith("goal-1");
    });

    it("calls rebalance when shouldRebalance returns a trigger", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const trigger = { type: "periodic" as const, details: "interval elapsed" };
      const portfolioManager = createMockPortfolioManager();
      portfolioManager.shouldRebalance.mockReturnValue(trigger);

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.rebalance).toHaveBeenCalledWith("goal-1", trigger);
    });

    it("calls onStallDetected when rebalance requires new generation", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const trigger = { type: "periodic" as const, details: "interval elapsed" };
      const portfolioManager = createMockPortfolioManager();
      portfolioManager.shouldRebalance.mockReturnValue(trigger);
      portfolioManager.rebalance.mockReturnValue({
        triggered_by: "periodic",
        adjustments: [],
        new_generation_needed: true,
        timestamp: new Date().toISOString(),
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.strategyManager.onStallDetected).toHaveBeenCalledWith("goal-1", 3, expect.any(String), undefined);
    });

    it("handles WaitStrategy expiry check — calls rebalance when handleWaitStrategyExpiry returns a trigger", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const waitStrategy = {
        id: "wait-strategy-1",
        state: "active",
        goal_id: "goal-1",
      };
      // Return a portfolio with a wait strategy
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });

      const waitTrigger = {
        type: "stall_detected" as const,
        strategy_id: waitStrategy.id,
        details: "wait period elapsed",
      };
      const portfolioManager = createMockPortfolioManager();
      portfolioManager.isWaitStrategy.mockReturnValue(true);
      portfolioManager.handleWaitStrategyExpiry.mockReturnValue({
        status: "worsened",
        goal_id: "goal-1",
        strategy_id: waitStrategy.id,
        rebalance_trigger: waitTrigger,
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.handleWaitStrategyExpiry).toHaveBeenCalledWith("goal-1", waitStrategy.id, undefined);
      expect(portfolioManager.rebalance).toHaveBeenCalledWith("goal-1", waitTrigger);
    });

    it("continues to task generation when wait rebalance requests a new strategy generation", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const waitStrategy = {
        id: "wait-strategy-1",
        state: "active",
        goal_id: "goal-1",
      };
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });

      const waitTrigger = {
        type: "stall_detected" as const,
        strategy_id: waitStrategy.id,
        details: "observation capability missing",
      };
      const portfolioManager = createMockPortfolioManager();
      portfolioManager.isWaitStrategy.mockReturnValue(true);
      portfolioManager.handleWaitStrategyExpiry.mockReturnValue({
        status: "unknown",
        goal_id: "goal-1",
        strategy_id: waitStrategy.id,
        rebalance_trigger: waitTrigger,
      });
      portfolioManager.rebalance.mockReturnValue({
        triggered_by: "stall_detected",
        adjustments: [],
        terminated_strategies: [waitStrategy.id],
        new_generation_needed: true,
        timestamp: new Date().toISOString(),
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.waitExpired).toBe(true);
      expect(result.waitObserveOnly).toBe(false);
      expect(mocks.strategyManager.onStallDetected).toHaveBeenCalledWith("goal-1", 3, expect.any(String), undefined);
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("marks waitExpired when WaitStrategy expiry does not require rebalance", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const waitStrategy = {
        id: "wait-strategy-1",
        state: "active",
        goal_id: "goal-1",
      };
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });

      const portfolioManager = createMockPortfolioManager();
      portfolioManager.isWaitStrategy.mockReturnValue(true);
      portfolioManager.handleWaitStrategyExpiry.mockReturnValue({
        status: "improved",
        goal_id: "goal-1",
        strategy_id: waitStrategy.id,
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.waitExpired).toBe(true);
      expect(result.waitStrategyId).toBe(waitStrategy.id);
      expect(result.waitExpiryOutcome).toMatchObject({ status: "improved" });
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("wait_observe_only");
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
      expect(portfolioManager.rebalance).not.toHaveBeenCalled();
    });

    it("keeps a not-due WaitStrategy observe-only and does not generate a task", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal({
        dimensions: [makeDimension({ name: "dim1" })],
      }));

      const waitUntil = new Date(Date.now() + 100_000).toISOString();
      const waitStrategy = {
        id: "wait-strategy-1",
        state: "active",
        goal_id: "goal-1",
        primary_dimension: "dim1",
        wait_until: waitUntil,
      };
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });
      mocks.stallDetector.isSuppressed.mockReturnValue(true);

      const portfolioManager = createMockPortfolioManager();
      portfolioManager.isWaitStrategy.mockReturnValue(true);
      portfolioManager.handleWaitStrategyExpiry.mockReturnValue({
        status: "not_due",
        goal_id: "goal-1",
        strategy_id: waitStrategy.id,
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.waitSuppressed).toBe(true);
      expect(result.waitStrategyId).toBe(waitStrategy.id);
      expect(result.waitExpiryOutcome).toMatchObject({ status: "not_due" });
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("wait_not_due");
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
    });

    it("observes a due WaitStrategy even when an earlier active wait is not due", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const notDueWait = {
        id: "wait-not-due",
        state: "active",
        goal_id: "goal-1",
      };
      const dueWait = {
        id: "wait-due",
        state: "active",
        goal_id: "goal-1",
      };
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [notDueWait, dueWait],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });

      const waitTrigger = {
        type: "stall_detected" as const,
        strategy_id: dueWait.id,
        details: "due wait worsened",
      };
      const portfolioManager = createMockPortfolioManager();
      portfolioManager.isWaitStrategy.mockReturnValue(true);
      portfolioManager.handleWaitStrategyExpiry
        .mockReturnValueOnce({
          status: "not_due",
          goal_id: "goal-1",
          strategy_id: notDueWait.id,
        })
        .mockReturnValueOnce({
          status: "worsened",
          goal_id: "goal-1",
          strategy_id: dueWait.id,
          rebalance_trigger: waitTrigger,
        });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.handleWaitStrategyExpiry).toHaveBeenCalledTimes(2);
      expect(result.waitExpired).toBe(true);
      expect(result.waitStrategyId).toBe(dueWait.id);
      expect(result.waitExpiryOutcome).toMatchObject({ status: "worsened" });
      expect(portfolioManager.rebalance).toHaveBeenCalledWith("goal-1", waitTrigger);
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
    });

    it("persists approval_required wait outcomes as pending runtime approvals", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const overdueWaitUntil = new Date(Date.now() - 100_000).toISOString();
      const waitStrategy = {
        id: "wait-approval",
        state: "active",
        goal_id: "goal-1",
        target_dimensions: ["dim1"],
        primary_dimension: "dim1",
        hypothesis: "Wait for external approval",
        expected_effect: [],
        resource_estimate: { sessions: 0, duration: { value: 0, unit: "hours" }, llm_calls: null },
        allocation: 1,
        created_at: new Date(Date.now() - 200_000).toISOString(),
        started_at: new Date(Date.now() - 200_000).toISOString(),
        completed_at: null,
        gap_snapshot_at_start: 0.5,
        tasks_generated: [],
        effectiveness_score: null,
        consecutive_stall_count: 0,
        wait_reason: "Approval required",
        wait_until: overdueWaitUntil,
        measurement_plan: "Resume after approval",
        fallback_strategy_id: null,
      };
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });
      await mocks.stateManager.writeRaw("strategies/goal-1/portfolio.json", {
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });
      await mocks.stateManager.writeRaw(`strategies/goal-1/wait-meta/${waitStrategy.id}.json`, {
        schema_version: 1,
        wait_until: overdueWaitUntil,
        conditions: [{ type: "time_until", until: overdueWaitUntil }],
        resume_plan: { action: "complete_wait" },
      });

      const portfolioManager = createMockPortfolioManager();
      portfolioManager.isWaitStrategy.mockReturnValue(true);
      portfolioManager.handleWaitStrategyExpiry.mockReturnValue({
        status: "approval_required",
        goal_id: "goal-1",
        strategy_id: waitStrategy.id,
        details: "Approve external submission",
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      const approvalStore = new ApprovalStore(path.join(tmpDir, "runtime"));
      const pending = await approvalStore.listPending();
      const metadata = await mocks.stateManager.readRaw(`strategies/goal-1/wait-meta/${waitStrategy.id}.json`) as Record<string, unknown>;
      const resolution = await new WaitDeadlineResolver(mocks.stateManager).resolve(["goal-1"]);

      expect(result.waitExpired).toBe(true);
      expect(result.waitApprovalId).toBe(`wait-goal-1-${waitStrategy.id}`);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        approval_id: result.waitApprovalId,
        goal_id: "goal-1",
        state: "pending",
      });
      expect(pending[0]!.payload).toMatchObject({
        task: {
          id: `wait:${waitStrategy.id}`,
          action: "wait_strategy_resume_approval",
          description: "Approve external submission",
        },
        wait_strategy_id: waitStrategy.id,
      });
      expect(Date.parse(metadata["next_observe_at"] as string)).toBeGreaterThan(Date.now());
      expect(metadata["approval_pending"]).toMatchObject({
        approval_id: result.waitApprovalId,
      });
      expect(metadata["latest_observation"]).toMatchObject({
        status: "pending",
        evidence: {
          approval_pending: true,
          approval_id: result.waitApprovalId,
        },
        resume_hint: "waiting_for_approval",
      });
      expect(getDueWaitGoalIds(resolution)).toEqual([]);
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
    });

    it("routes approval_required wait outcomes through the live approval broker when available", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const waitStrategy = {
        id: "wait-live-approval",
        state: "active",
        goal_id: "goal-1",
      };
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });

      const portfolioManager = createMockPortfolioManager();
      portfolioManager.isWaitStrategy.mockReturnValue(true);
      portfolioManager.handleWaitStrategyExpiry.mockReturnValue({
        status: "approval_required",
        goal_id: "goal-1",
        strategy_id: waitStrategy.id,
        details: "Approve external submission",
      });
      const waitApprovalBroker = {
        requestApproval: vi.fn().mockResolvedValue(false),
      };

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any, waitApprovalBroker };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.waitApprovalId).toBe(`wait-goal-1-${waitStrategy.id}`);
      expect(waitApprovalBroker.requestApproval).toHaveBeenCalledWith(
        "goal-1",
        {
          id: `wait:${waitStrategy.id}`,
          description: "Approve external submission",
          action: "wait_strategy_resume_approval",
        },
        24 * 60 * 60 * 1000,
        result.waitApprovalId
      );
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
    });

    it("handles active WaitStrategy before stall checks", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal({
        dimensions: [makeDimension({ name: "dim1" })],
      }));

      const waitUntil = new Date(Date.now() + 100_000).toISOString();
      const waitStrategy = {
        id: "wait-strategy-1",
        state: "active",
        goal_id: "goal-1",
        primary_dimension: "dim1",
        wait_until: waitUntil,
      };
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });
      mocks.stallDetector.isSuppressed.mockReturnValue(true);

      const portfolioManager = createMockPortfolioManager();
      portfolioManager.isWaitStrategy.mockReturnValue(true);
      portfolioManager.handleWaitStrategyExpiry.mockReturnValue({
        status: "not_due",
        goal_id: "goal-1",
        strategy_id: waitStrategy.id,
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.handleWaitStrategyExpiry).toHaveBeenCalledWith("goal-1", waitStrategy.id, undefined);
      expect(mocks.stallDetector.isSuppressed).not.toHaveBeenCalled();
      expect(mocks.stallDetector.checkDimensionStall).not.toHaveBeenCalled();
      expect(result.waitSuppressed).toBe(true);
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
    });

    it("portfolio rebalance errors are non-fatal", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const portfolioManager = createMockPortfolioManager();
      portfolioManager.shouldRebalance.mockImplementation(() => {
        throw new Error("rebalance check failed");
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      // Should still reach task cycle
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
      expect(result.error).toBeNull();
    });
  });
});

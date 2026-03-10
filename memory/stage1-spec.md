# Stage 1 実装仕様書

作成日: 2026-03-10
対象: Stage 1 — 型定義 (types)、StateManager、GapCalculator
参照設計ドキュメント: state-vector.md, gap-calculation.md, goal-negotiation.md, observation.md, drive-scoring.md, task-lifecycle.md, trust-and-safety.md, satisficing.md, stall-detection.md, session-and-context.md, drive-system.md, execution-boundary.md, mechanism.md, runtime.md, knowledge-acquisition.md, portfolio-management.md, reporting.md

---

## A. Zod スキーマ仕様

### A-1. コア enum / literal

#### `ThresholdType`
```typescript
// state-vector.md §2
export const ThresholdTypeSchema = z.enum(['min', 'max', 'range', 'present', 'match']);
export type ThresholdType = z.infer<typeof ThresholdTypeSchema>;
```

#### `ConfidenceTier`
```typescript
// observation.md §5
export const ConfidenceTierSchema = z.enum(['mechanical', 'independent_review', 'self_report']);
export type ConfidenceTier = z.infer<typeof ConfidenceTierSchema>;
```

#### `ObservationMethodType`
```typescript
// observation.md §5
export const ObservationMethodTypeSchema = z.enum([
  'mechanical',
  'llm_review',
  'api_query',
  'file_check',
  'manual',
]);
export type ObservationMethodType = z.infer<typeof ObservationMethodTypeSchema>;
```

#### `ObservationTrigger`
```typescript
// observation.md §8
export const ObservationTriggerSchema = z.enum([
  'post_task',
  'periodic',
  'event_driven',
]);
export type ObservationTrigger = z.infer<typeof ObservationTriggerSchema>;
```

#### `ObservationLayer`
```typescript
// observation.md §8
export const ObservationLayerSchema = z.enum([
  'mechanical',
  'independent_review',
  'self_report',
]);
export type ObservationLayer = z.infer<typeof ObservationLayerSchema>;
```

#### `AggregationMethod`
```typescript
// state-vector.md §4, gap-calculation.md §6
export const AggregationMethodSchema = z.enum(['min', 'weighted_avg', 'max']);
export type AggregationMethod = z.infer<typeof AggregationMethodSchema>;
```

#### `GoalStatus`
```typescript
// goal-negotiation.md, mechanism.md §3
export const GoalStatusSchema = z.enum([
  'negotiating',
  'active',
  'completed',
  'cancelled',
  'waiting',
]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;
```

#### `GoalNodeType`
```typescript
// state-vector.md §8
export const GoalNodeTypeSchema = z.enum(['goal', 'subgoal', 'milestone']);
export type GoalNodeType = z.infer<typeof GoalNodeTypeSchema>;
```

#### `NegotiationResponseType`
```typescript
// goal-negotiation.md §4
export const NegotiationResponseTypeSchema = z.enum([
  'accept',
  'counter_propose',
  'flag_as_ambitious',
]);
export type NegotiationResponseType = z.infer<typeof NegotiationResponseTypeSchema>;
```

#### `FeasibilityAssessment`
```typescript
// goal-negotiation.md §3
export const FeasibilityAssessmentSchema = z.enum([
  'realistic',
  'ambitious',
  'infeasible',
  'unknown',
]);
export type FeasibilityAssessment = z.infer<typeof FeasibilityAssessmentSchema>;
```

#### `TaskStatus`
```typescript
// task-lifecycle.md (execution_state)
export const TaskStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'timed_out',
  'error',
  'failed',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
```

#### `TaskVerdict`
```typescript
// task-lifecycle.md §5
export const TaskVerdictSchema = z.enum(['pass', 'partial', 'fail']);
export type TaskVerdict = z.infer<typeof TaskVerdictSchema>;
```

#### `Reversibility`
```typescript
// task-lifecycle.md §2.9
export const ReversibilitySchema = z.enum([
  'reversible',
  'irreversible',
  'unknown',
]);
export type Reversibility = z.infer<typeof ReversibilitySchema>;
```

#### `FailureDisposition`
```typescript
// task-lifecycle.md §6
export const FailureDispositionSchema = z.enum(['keep', 'discard', 'escalate']);
export type FailureDisposition = z.infer<typeof FailureDispositionSchema>;
```

#### `StateIntegrity`
```typescript
// task-lifecycle.md §6
export const StateIntegritySchema = z.enum(['ok', 'uncertain', 'dirty']);
export type StateIntegrity = z.infer<typeof StateIntegritySchema>;
```

#### `StallType`
```typescript
// stall-detection.md §2
export const StallTypeSchema = z.enum([
  'dimension_stall',
  'time_exceeded',
  'consecutive_failure',
  'global_stall',
]);
export type StallType = z.infer<typeof StallTypeSchema>;
```

#### `StallCause`
```typescript
// stall-detection.md §3
export const StallCauseSchema = z.enum([
  'information_gap',
  'approach_failure',
  'capability_limit',
  'external_dependency',
  'goal_infeasible',
]);
export type StallCause = z.infer<typeof StallCauseSchema>;
```

#### `StrategyState`
```typescript
// portfolio-management.md §1.2
export const StrategyStateSchema = z.enum([
  'candidate',
  'active',
  'evaluating',
  'suspended',
  'completed',
  'terminated',
]);
export type StrategyState = z.infer<typeof StrategyStateSchema>;
```

#### `DependencyType`
```typescript
// session-and-context.md §9
export const DependencyTypeSchema = z.enum([
  'prerequisite',
  'resource_conflict',
  'synergy',
  'conflict',
]);
export type DependencyType = z.infer<typeof DependencyTypeSchema>;
```

#### `DependencyStatus`
```typescript
// session-and-context.md §9
export const DependencyStatusSchema = z.enum([
  'active',
  'satisfied',
  'invalidated',
]);
export type DependencyStatus = z.infer<typeof DependencyStatusSchema>;
```

#### `DurationUnit`
```typescript
// task-lifecycle.md §2.7
export const DurationUnitSchema = z.enum(['minutes', 'hours', 'days']);
export type DurationUnit = z.infer<typeof DurationUnitSchema>;
```

#### `EventType`
```typescript
// drive-system.md §3
export const EventTypeSchema = z.enum(['external', 'internal']);
export type EventType = z.infer<typeof EventTypeSchema>;
```

#### `NotificationType`
```typescript
// reporting.md §2.2
export const NotificationTypeSchema = z.enum([
  'urgent_alert',
  'approval_request',
  'stall_escalation',
  'goal_completion',
  'capability_gap',
  'strategy_change',
]);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;
```

---

### A-2. ゴール型 (Goal, GoalTree, Dimension, Threshold)

#### `Threshold`
```typescript
// state-vector.md §2 — 5閾値型すべて対応
export const ThresholdSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('min'),
    value: z.number(),           // N以上で達成
  }),
  z.object({
    type: z.literal('max'),
    value: z.number(),           // N以下で達成
  }),
  z.object({
    type: z.literal('range'),
    low: z.number(),             // 範囲下限（含む）
    high: z.number(),            // 範囲上限（含む）
  }),
  z.object({
    type: z.literal('present'),  // 存在すれば達成。valueなし
  }),
  z.object({
    type: z.literal('match'),
    value: z.union([z.string(), z.number(), z.boolean()]),  // 一致で達成
  }),
]);
export type Threshold = z.infer<typeof ThresholdSchema>;
```

#### `ObservationMethod`
```typescript
// observation.md §5 — 構造化スキーマ
export const ObservationMethodSchema = z.object({
  type: ObservationMethodTypeSchema,
  source: z.string(),                  // 例: "fitbit_api", "git_log", "user_input"
  schedule: z.string().nullable(),     // cron式。イベント駆動/手動の場合は null
  endpoint: z.string().nullable(),     // URL またはファイルパス。manual/llm_review は null
  confidence_tier: ConfidenceTierSchema,
});
export type ObservationMethod = z.infer<typeof ObservationMethodSchema>;
```

#### `HistoryEntry`
```typescript
// state-vector.md §2, observation.md §8 — Dimension.history の各エントリ
export const HistoryEntrySchema = z.object({
  value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  timestamp: z.string(),               // ISO 8601
  confidence: z.number().min(0).max(1),
  source_observation_id: z.string(),   // observation_id への結合キー (UUID)
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
```

#### `DimensionMapping`
```typescript
// satisficing.md §7 — サブゴール次元→親ゴール次元の伝播定義
export const DimensionMappingSchema = z.object({
  parent_dimension: z.string(),
  aggregation: z.enum(['min', 'avg', 'max', 'all_required']),
});
export type DimensionMapping = z.infer<typeof DimensionMappingSchema>;
```

#### `Dimension`
```typescript
// state-vector.md §2 — 状態ベクトルの構成要素
// 備考:
//   current_value = null は初回観測前 (観測後に設定される)
//   confidence = 0.0 は初期値 (観測後に更新される)
//   uncertainty_weight: グローバル設定か次元別オーバーライド (gap-calculation.md §4)
export const DimensionSchema = z.object({
  name: z.string(),                    // 機械的識別名 例: "daily_steps"
  label: z.string(),                   // 人間向け表示名 例: "1日の歩数"
  current_value: z.union([
    z.number(),
    z.string(),
    z.boolean(),
    z.null(),
  ]),                                  // null = 初回観測前
  threshold: ThresholdSchema,
  confidence: z.number().min(0).max(1),  // デフォルト: 0.0
  observation_method: ObservationMethodSchema,
  last_updated: z.string().nullable(),   // ISO 8601。null = 未観測
  history: z.array(HistoryEntrySchema),  // 停滞検知用の過去値リスト
  // オプションフィールド
  uncertainty_weight: z.number().min(0).optional(),  // 次元別オーバーライド。未設定=グローバル値を使用
  state_integrity: StateIntegritySchema.default('ok'),  // task-lifecycle.md §6
  dimension_mapping: DimensionMappingSchema.optional(), // satisficing.md §7。MVP: 名前一致のみ
  weight: z.number().positive().optional(),            // 加重平均集約時の重み
});
export type Dimension = z.infer<typeof DimensionSchema>;
```

#### `StateVector`
```typescript
// state-vector.md §1〜§4
export const StateVectorSchema = z.object({
  dimensions: z.array(DimensionSchema).min(1),
  aggregation_method: AggregationMethodSchema.default('min'),
  // 注: uncertainty_weight のグローバルデフォルト (gap-calculation.md §4)
  global_uncertainty_weight: z.number().min(0).default(1.0),
});
export type StateVector = z.infer<typeof StateVectorSchema>;
```

#### `Constraint`
```typescript
// task-lifecycle.md §2.5
export const ConstraintSchema = z.object({
  id: z.string(),
  description: z.string(),
  is_hard: z.boolean().default(true),  // true = ハード制約 (違反禁止)
});
export type Constraint = z.infer<typeof ConstraintSchema>;
```

#### `MilestoneSpecificFields`
```typescript
// state-vector.md §8
export const MilestoneSpecificFieldsSchema = z.object({
  target_date: z.string(),                               // ISO 8601
  origin: z.enum(['negotiation', 'decomposition', 'manual']),
  pace_snapshot: z.object({
    elapsed_ratio: z.number().min(0).max(1),
    achievement_ratio: z.number().min(0),
    pace_ratio: z.number().min(0),
    status: z.enum(['on_track', 'at_risk', 'behind']),
    evaluated_at: z.string(),
  }).nullable().default(null),
});
export type MilestoneSpecificFields = z.infer<typeof MilestoneSpecificFieldsSchema>;
```

#### `Goal`
```typescript
// mechanism.md §3, state-vector.md §4〜§8, goal-negotiation.md §8
// 備考: Goal はゴールツリーの任意のノード (root goal / subgoal / milestone) を表す
export const GoalSchema = z.object({
  id: z.string(),                              // UUID
  parent_id: z.string().nullable(),            // null = ルートゴール
  type: GoalNodeTypeSchema,                    // 'goal' | 'subgoal' | 'milestone'
  title: z.string(),
  description: z.string(),
  status: GoalStatusSchema,
  state_vector: StateVectorSchema,
  constraints: z.array(ConstraintSchema),
  children: z.array(z.string()),               // 子ノードのID一覧 (参照のみ)
  // 信頼とトラスト
  confidence: z.enum(['high', 'medium', 'low']).default('low'),
  flag: z.string().optional(),                 // 例: "user-override" (goal-negotiation.md §5)
  feasibility_note: z.string().optional(),
  // タイムライン
  deadline: z.string().nullable(),             // ISO 8601。期限なしゴールは null
  created_at: z.string(),
  completed_at: z.string().nullable(),
  // マイルストーン固有 (type === 'milestone' のときのみ有意)
  milestone: MilestoneSpecificFieldsSchema.optional(),
});
export type Goal = z.infer<typeof GoalSchema>;
```

#### `GoalTree`
```typescript
// mechanism.md §3, session-and-context.md §9
// ファイル: ~/.motiva/goals/<goal_id>/goal_tree.json
export const GoalTreeSchema = z.object({
  root_id: z.string(),
  nodes: z.record(z.string(), GoalSchema),     // goal_id -> Goal
  // 依存グラフ (session-and-context.md §9)
  dependency_edges: z.array(z.object({
    from: z.string(),                           // goal_id
    to: z.string(),                             // goal_id
    type: DependencyTypeSchema,
    condition: z.string().optional(),           // 例: "goal_infrastructure.achievement >= 0.9"
    affected_dimensions: z.array(z.string()).optional(),
    mitigation: z.string().optional(),
    status: DependencyStatusSchema.default('active'),
    detection_confidence: z.number().min(0).max(1).optional(),
    description: z.string().optional(),
  })),
  created_at: z.string(),
  updated_at: z.string(),
});
export type GoalTree = z.infer<typeof GoalTreeSchema>;
```

#### `GoalNegotiationLog`
```typescript
// goal-negotiation.md §8
// ファイル: ~/.motiva/goals/<goal_id>/negotiation_log.json
export const GoalNegotiationLogSchema = z.object({
  goal_id: z.string(),
  timestamp: z.string(),
  step2_decomposition: z.object({
    dimensions: z.array(z.string()),
    method: z.string(),
  }).optional(),
  step3_baseline: z.object({
    observations: z.array(z.object({
      dimension: z.string(),
      value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
      confidence: z.number().min(0).max(1),
      method: z.string(),
    })),
  }).optional(),
  step4_evaluation: z.object({
    path: z.enum(['quantitative', 'qualitative', 'hybrid']),
    dimensions: z.array(z.object({
      name: z.string(),
      path: z.enum(['quantitative', 'qualitative']),
      feasibility_ratio: z.number().optional(),
      assessment: FeasibilityAssessmentSchema,
      confidence: z.enum(['high', 'medium', 'low']).optional(),
      reasoning: z.string().optional(),
    })),
  }).optional(),
  step5_response: z.object({
    type: NegotiationResponseTypeSchema,
    accepted: z.boolean(),
    initial_confidence: z.enum(['high', 'medium', 'low']),
    user_acknowledged: z.boolean(),
  }).optional(),
});
export type GoalNegotiationLog = z.infer<typeof GoalNegotiationLogSchema>;
```

---

### A-3. 状態型 (StateVector, CurrentState, ObservationLog)

#### `ObservationLogEntry`
```typescript
// observation.md §8 — 観測ログの各エントリ
export const ObservationLogEntrySchema = z.object({
  observation_id: z.string(),          // UUID 例: "obs_a1b2c3d4"
  timestamp: z.string(),               // ISO 8601 UTC
  trigger: ObservationTriggerSchema,
  goal_id: z.string(),
  dimension_name: z.string(),
  layer: ObservationLayerSchema,
  method: ObservationMethodSchema,
  raw_result: z.unknown(),             // 観測の生の結果 (型はsourceに依存)
  extracted_value: z.union([
    z.number(),
    z.string(),
    z.boolean(),
    z.null(),
  ]),
  confidence: z.number().min(0).max(1),
  notes: z.string().optional(),
});
export type ObservationLogEntry = z.infer<typeof ObservationLogEntrySchema>;
```

#### `ObservationLog`
```typescript
// observation.md §8
// ファイル: ~/.motiva/goals/<goal_id>/observation_log.json
// 備考: 結合キーは goal_id + dimension_name + timestamp (タプルで一意)
export const ObservationLogSchema = z.object({
  goal_id: z.string(),
  entries: z.array(ObservationLogEntrySchema),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ObservationLog = z.infer<typeof ObservationLogSchema>;
```

---

### A-4. ギャップ型 (RawGap, NormalizedGap, WeightedGap, GapVector)

#### `RawGap`
```typescript
// gap-calculation.md §1
// 備考:
//   is_null_guard = true の場合、current_value が null だったことを示す
//   数値型 (min/max/range): raw_gap = 差の絶対値 (>= 0)
//   二値型 (present/match): raw_gap = 0 または 1
export const RawGapSchema = z.object({
  dimension_name: z.string(),
  threshold_type: ThresholdTypeSchema,
  raw_gap: z.number().min(0),
  is_null_guard: z.boolean(),          // current_value が null だったか
});
export type RawGap = z.infer<typeof RawGapSchema>;
```

#### `NormalizedGap`
```typescript
// gap-calculation.md §2
// 備考: normalized_gap ∈ [0, 1]
//   数値型: raw_gap / normalize_denominator (0除算時は1.0)
//   二値型: raw_gap そのまま (すでに 0 or 1)
//   null guard: 1.0 固定
export const NormalizedGapSchema = z.object({
  dimension_name: z.string(),
  threshold_type: ThresholdTypeSchema,
  raw_gap: z.number().min(0),
  normalized_gap: z.number().min(0).max(1),
  normalize_denominator: z.number().optional(), // 除算で使った値 (デバッグ用)
  is_null_guard: z.boolean(),
});
export type NormalizedGap = z.infer<typeof NormalizedGapSchema>;
```

#### `WeightedGap`
```typescript
// gap-calculation.md §3
// 備考:
//   normalized_weighted_gap = normalized_gap × (1 + (1 - confidence) × uncertainty_weight)
//   ただし is_null_guard = true の場合は信頼度加重を適用しない (normalized_gap のまま)
//   is_null_guard = true かつ normalized_gap = 1.0 の場合、weighted も 1.0
export const WeightedGapSchema = z.object({
  dimension_name: z.string(),
  threshold_type: ThresholdTypeSchema,
  raw_gap: z.number().min(0),
  normalized_gap: z.number().min(0).max(1),
  normalized_weighted_gap: z.number().min(0),  // >1.0 になりうる (信頼度加重)
  confidence: z.number().min(0).max(1),
  uncertainty_weight: z.number().min(0),
  is_null_guard: z.boolean(),
});
export type WeightedGap = z.infer<typeof WeightedGapSchema>;
```

#### `GapVector`
```typescript
// gap-calculation.md §5〜§8
// ファイル: ~/.motiva/goals/<goal_id>/gap_history.json に各反復スナップショットを追記
export const GapVectorSchema = z.object({
  goal_id: z.string(),
  iteration: z.number().int().min(0),
  timestamp: z.string(),               // ISO 8601
  gaps: z.array(WeightedGapSchema),
  // 集約 (gap-calculation.md §6)
  aggregated_gap: z.number().min(0),   // ボトルネック集約 (Max) がデフォルト
  aggregation_method: AggregationMethodSchema,
  // 変化量 (停滞検知用) (gap-calculation.md §8)
  gap_delta: z.record(z.string(), z.number()).optional(), // dimension_name -> delta
  confidence_vector: z.record(z.string(), z.number()),    // dimension_name -> confidence
});
export type GapVector = z.infer<typeof GapVectorSchema>;
```

---

### A-5. トラスト型 (TrustBalance, ConfidenceLevel)

#### `TrustBalance`
```typescript
// trust-and-safety.md §2 — 数値仕様 (v1デフォルト)
// 備考:
//   range: [-100, +100] 整数
//   Δs = +3 (検証済み成功)
//   Δf = -10 (検証済み失敗)
//   高トラスト境界 = +20 以上
//   低トラスト境界 = +20 未満
export const TrustBalanceSchema = z.object({
  domain: z.string(),                  // 例: "code_tasks", "business_strategy"
  value: z.number().int().min(-100).max(100), // 整数
  delta_success: z.number().int().default(3),
  delta_failure: z.number().int().default(-10),
  high_trust_threshold: z.number().int().default(20),
  updated_at: z.string(),
});
export type TrustBalance = z.infer<typeof TrustBalanceSchema>;
```

#### `TrustState`
```typescript
// trust-and-safety.md §2〜§4
// ファイル: ~/.motiva/trust_state.json
export const TrustStateSchema = z.object({
  balances: z.record(z.string(), TrustBalanceSchema), // domain -> TrustBalance
  // ユーザーオーバーライド (trust-and-safety.md §6)
  permanent_gates: z.array(z.object({
    category: z.string(),
    description: z.string(),
    created_at: z.string(),
  })),
  override_log: z.array(z.object({
    timestamp: z.string(),
    type: z.enum(['trust_grant', 'permanent_gate']),
    target: z.string(),
    value_before: z.union([z.number(), z.null()]),
    value_after: z.union([z.number(), z.string(), z.null()]),
    description: z.string(),
  })),
});
export type TrustState = z.infer<typeof TrustStateSchema>;
```

#### `ConfidenceLevel`
```typescript
// trust-and-safety.md §2 — 確信度境界定義
// 備考:
//   high: confidence >= 0.50 (機械的検証 + 独立レビューを含む)
//   low:  confidence < 0.50  (自己申告のみ)
export const ConfidenceLevelSchema = z.enum(['high', 'low']);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

// 確信度の閾値定数 (コード上で参照するために別途エクスポート)
export const CONFIDENCE_THRESHOLD = 0.50;
export const MECHANICAL_CONFIDENCE_MIN = 0.85;
export const INDEPENDENT_REVIEW_CONFIDENCE_MIN = 0.50;
export const INDEPENDENT_REVIEW_CONFIDENCE_MAX = 0.84;
export const SELF_REPORT_CONFIDENCE_MIN = 0.10;
export const SELF_REPORT_CONFIDENCE_MAX = 0.49;
```

#### `Quadrant`
```typescript
// trust-and-safety.md §2 — 4象限行動マトリクス
// 備考:
//   quadrant_1: trust_balance >= 20 AND confidence >= 0.50 → 自律実行
//   quadrant_2: trust_balance >= 20 AND confidence < 0.50  → 実行+確認
//   quadrant_3: trust_balance < 20  AND confidence >= 0.50 → 実行+確認
//   quadrant_4: trust_balance < 20  AND confidence < 0.50  → 観測優先+計画提案
export const QuadrantSchema = z.enum([
  'quadrant_1_autonomous',
  'quadrant_2_execute_confirm',
  'quadrant_3_execute_confirm',
  'quadrant_4_observe_propose',
]);
export type Quadrant = z.infer<typeof QuadrantSchema>;
```

---

### A-6. タスク型 (Task, TaskResult)

#### `Duration`
```typescript
// task-lifecycle.md §2.7
export const DurationSchema = z.object({
  value: z.number().positive(),
  unit: DurationUnitSchema,
});
export type Duration = z.infer<typeof DurationSchema>;
```

#### `Criterion`
```typescript
// task-lifecycle.md §2.3
export const CriterionSchema = z.object({
  description: z.string(),
  verification_method: z.string(),
  is_blocking: z.boolean(),
});
export type Criterion = z.infer<typeof CriterionSchema>;
```

#### `ScopeBoundary`
```typescript
// task-lifecycle.md §2.4
export const ScopeBoundarySchema = z.object({
  in_scope: z.array(z.string()),
  out_of_scope: z.array(z.string()),
  blast_radius: z.string(),
});
export type ScopeBoundary = z.infer<typeof ScopeBoundarySchema>;
```

#### `ExecutionState`
```typescript
// task-lifecycle.md §4
export const ExecutionStateSchema = z.object({
  status: TaskStatusSchema,
  started_at: z.string().nullable(),
  timeout_at: z.string().nullable(),
  heartbeat_at: z.string().nullable(),
});
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;
```

#### `Task`
```typescript
// task-lifecycle.md §2 — タスクの全フィールド
export const TaskSchema = z.object({
  id: z.string(),                       // UUID
  goal_id: z.string(),
  strategy_id: z.string().nullable(),   // portfolio-management.md §8.2

  // 2.1 ターゲット次元
  target_dimensions: z.array(z.string()).min(1),
  primary_dimension: z.string(),

  // 2.2 作業内容
  work_description: z.string(),
  rationale: z.string(),
  approach: z.string(),

  // 2.3 成功基準
  success_criteria: z.array(CriterionSchema).min(1),

  // 2.4 スコープ境界
  scope_boundary: ScopeBoundarySchema,

  // 2.5 継承制約
  constraints: z.array(ConstraintSchema),

  // 2.6 意図的待機
  plateau_until: z.string().nullable(),  // ISO 8601 または null

  // 2.7 見積もり所要時間
  estimated_duration: DurationSchema.nullable(),

  // 2.8 連続失敗カウント (システム全体の唯一の失敗カウンター)
  consecutive_failure_count: z.number().int().min(0).default(0),
  failure_escalation_threshold: z.number().int().positive().default(3),

  // 2.9 可逆性タグ
  reversibility: ReversibilitySchema,

  // 実行状態
  execution_state: ExecutionStateSchema,

  // タイムスタンプ
  created_at: z.string(),
  updated_at: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;
```

#### `Evidence`
```typescript
// task-lifecycle.md §5 (verification_result)
export const EvidenceSchema = z.object({
  layer: ObservationLayerSchema,
  description: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
```

#### `DimensionUpdate`
```typescript
// task-lifecycle.md §5 (verification_result.dimension_updates)
export const DimensionUpdateSchema = z.object({
  dimension_name: z.string(),
  value_before: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  value_after: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  confidence: z.number().min(0).max(1),
});
export type DimensionUpdate = z.infer<typeof DimensionUpdateSchema>;
```

#### `ReviewerSessionOutput`
```typescript
// task-lifecycle.md §5 Layer 2
export const ReviewerSessionOutputSchema = z.object({
  criteria_met: z.array(z.boolean()),
  quality_assessment: z.string(),
  concerns: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type ReviewerSessionOutput = z.infer<typeof ReviewerSessionOutputSchema>;
```

#### `ExecutorReport`
```typescript
// task-lifecycle.md §5 Layer 3
export const ExecutorReportSchema = z.object({
  completed: z.boolean(),
  summary: z.string(),
  partial_results: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type ExecutorReport = z.infer<typeof ExecutorReportSchema>;
```

#### `TaskResult`
```typescript
// task-lifecycle.md §5 (verification_result) + §6 (失敗対応)
export const TaskResultSchema = z.object({
  task_id: z.string(),
  verdict: TaskVerdictSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceSchema),
  dimension_updates: z.array(DimensionUpdateSchema),
  // 失敗対応
  disposition: FailureDispositionSchema.optional(),
  failure_reason: z.string().optional(),
  // セッション出力 (保管用)
  reviewer_output: ReviewerSessionOutputSchema.optional(),
  executor_report: ExecutorReportSchema.optional(),
  completed_at: z.string(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;
```

---

### A-7. セッション型

#### `SessionType`
```typescript
// session-and-context.md §5
export const SessionTypeSchema = z.enum([
  'task_execution',
  'observation',
  'task_review',
  'goal_review',
  'negotiation',
  'strategy',
]);
export type SessionType = z.infer<typeof SessionTypeSchema>;
```

#### `ContextItem`
```typescript
// session-and-context.md §4 — コンテキストバジェット管理用
export const ContextItemSchema = z.object({
  priority: z.number().int().min(1).max(6),  // §4 の優先度順
  label: z.string(),
  content: z.string(),
  char_count: z.number().int(),
});
export type ContextItem = z.infer<typeof ContextItemSchema>;
```

#### `SessionRecord`
```typescript
// session-and-context.md §2〜§5
// ファイル: ~/.motiva/goals/<goal_id>/session_log.json
export const SessionRecordSchema = z.object({
  session_id: z.string(),
  type: SessionTypeSchema,
  goal_id: z.string(),
  task_id: z.string().nullable(),      // task_execution / task_review 時のみ
  context_items: z.array(ContextItemSchema),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  result_summary: z.string().optional(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
```

---

### A-8. 戦略型

#### `ResourceEstimate`
```typescript
// portfolio-management.md §1.1
export const ResourceEstimateSchema = z.object({
  sessions: z.number().int().min(0),
  duration: DurationSchema,
  llm_calls: z.number().int().min(0).nullable(),
});
export type ResourceEstimate = z.infer<typeof ResourceEstimateSchema>;
```

#### `ExpectedEffect`
```typescript
// portfolio-management.md §1.1
export const ExpectedEffectSchema = z.object({
  dimension: z.string(),
  direction: z.enum(['increase', 'decrease']),
  magnitude: z.enum(['small', 'medium', 'large']),
});
export type ExpectedEffect = z.infer<typeof ExpectedEffectSchema>;
```

#### `Strategy`
```typescript
// portfolio-management.md §1
// ファイル: ~/.motiva/goals/<goal_id>/strategies.json (strategies 配列内)
export const StrategySchema = z.object({
  id: z.string(),
  goal_id: z.string(),
  target_dimensions: z.array(z.string()).min(1),
  primary_dimension: z.string(),
  hypothesis: z.string(),
  expected_effect: z.array(ExpectedEffectSchema),
  resource_estimate: ResourceEstimateSchema,
  state: StrategyStateSchema,
  allocation: z.number().min(0).max(1),
  created_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  gap_snapshot_at_start: z.number().nullable(),
  tasks_generated: z.array(z.string()),         // task ID 一覧
  effectiveness_score: z.number().nullable(),   // null = データ不足
  consecutive_stall_count: z.number().int().min(0).default(0),
  // plateau_until と連動 (task-lifecycle.md §2.6 / portfolio-management.md §1.2)
  plateau_until: z.string().nullable(),
});
export type Strategy = z.infer<typeof StrategySchema>;
```

#### `Portfolio`
```typescript
// portfolio-management.md §3
// ファイル: ~/.motiva/goals/<goal_id>/strategies.json
export const PortfolioSchema = z.object({
  goal_id: z.string(),
  strategies: z.array(StrategySchema),
  rebalance_interval: DurationSchema,
  last_rebalanced_at: z.string().nullable(),
});
export type Portfolio = z.infer<typeof PortfolioSchema>;
```

---

### A-9. 駆動型

#### `DriveScores`
```typescript
// drive-scoring.md §1〜§4
export const DriveScoresSchema = z.object({
  goal_id: z.string(),
  dimension_name: z.string(),
  // 各駆動スコア (drive-scoring.md §1〜§3)
  score_dissatisfaction: z.number().min(0),
  score_deadline: z.number().min(0),
  score_opportunity: z.number().min(0),
  // 最終スコア (drive-scoring.md §4 Max + 締切オーバーライド)
  final_score: z.number().min(0),
  // デバッグ用内訳
  decay_factor: z.number().min(0).max(1).optional(),    // 不満駆動
  urgency: z.number().min(0).optional(),                 // 締切駆動
  opportunity_value: z.number().min(0).optional(),       // 機会駆動
  freshness_decay: z.number().min(0).max(1).optional(),  // 機会駆動
  calculated_at: z.string(),
});
export type DriveScores = z.infer<typeof DriveScoresSchema>;
```

#### `MotivationEvent`
```typescript
// drive-system.md §3 — イベントキュー (MVP: ファイルベース)
// ファイル: ~/.motiva/events/<timestamp>-<source>-<event>.json
export const MotivationEventSchema = z.object({
  type: EventTypeSchema,
  source: z.string(),
  timestamp: z.string(),               // ISO 8601 UTC
  data: z.record(z.string(), z.unknown()),
});
export type MotivationEvent = z.infer<typeof MotivationEventSchema>;
```

---

### A-10. レポート型

#### `ReportType`
```typescript
// reporting.md §2
export const ReportTypeSchema = z.enum([
  'daily_summary',
  'weekly_report',
  'immediate_notification',
  'strategy_change',
]);
export type ReportType = z.infer<typeof ReportTypeSchema>;
```

#### `ReportRecord`
```typescript
// reporting.md §2〜§8
// ファイル: ~/.motiva/reports/<daily|weekly|notifications>/<filename>.md (内容はMarkdown)
//           + ~/.motiva/reports/index.json (メタデータ一覧)
export const ReportRecordSchema = z.object({
  report_id: z.string(),
  type: ReportTypeSchema,
  notification_type: NotificationTypeSchema.optional(),
  generated_at: z.string(),
  file_path: z.string(),               // 絶対パス
  is_read: z.boolean().default(false),
  goal_ids: z.array(z.string()),
});
export type ReportRecord = z.infer<typeof ReportRecordSchema>;
```

---

## B. StateManager 仕様

### B-1. ファイルレイアウト

```
~/.motiva/
├── goals/
│   └── <goal_id>/
│       ├── goal_tree.json           GoalTree (全ノード含む)
│       ├── observation_log.json     ObservationLog (全観測エントリ)
│       ├── gap_history.json         GapVector[] (全反復スナップショット)
│       ├── strategies.json          Portfolio (Strategy[] 含む)
│       ├── session_log.json         SessionRecord[] (セッション記録)
│       ├── domain_knowledge.json    DomainKnowledge (knowledge-acquisition.md §5.2)
│       └── negotiation_log.json     GoalNegotiationLog
├── tasks/
│   └── <task_id>.json               Task (個別ファイル)
├── task_results/
│   └── <task_id>_result.json        TaskResult
├── trust_state.json                 TrustState (全ドメインのトラストバランス)
├── events/
│   ├── <timestamp>-<source>.json    MotivationEvent (未処理)
│   └── archive/
│       └── <timestamp>-<source>.json MotivationEvent (処理済み)
└── reports/
    ├── daily/
    │   └── <YYYY-MM-DD>.md
    ├── weekly/
    │   └── <YYYY-WNN>.md
    ├── notifications/
    │   └── <YYYYMMDDHHmmss>-<type>.md
    ├── archive/
    └── index.json                   ReportRecord[] (未読管理)
```

### B-2. アトミック書き込み戦略

すべてのファイル書き込みに対してアトミック書き込みを使用する。

```
手順:
1. ターゲットパスに `.tmp` サフィックスを付けた一時ファイルに書き込む
   例: goal_tree.json.tmp
2. 書き込みが完了したら fsync() を呼び出してディスクに確実に書き込む
3. rename() (POSIX atomic rename) でターゲットパスに原子的に移動する
   例: goal_tree.json.tmp -> goal_tree.json

理由: rename() は同一ファイルシステム内で原子的操作であり、
クラッシュが発生しても読み取り可能な古いファイルか
完全な新ファイルのどちらかが残る (部分書き込みは発生しない)
```

実装では Node.js の `fs.promises.rename()` と `fs.promises.writeFile()` を使用する。ディレクトリが存在しない場合は `fs.promises.mkdir({ recursive: true })` で作成する。

### B-3. CRUD 操作一覧

StateManager が提供する全操作を列挙する。

#### ゴールツリー操作

```typescript
// ゴールツリー全体の取得 (goal_tree.json を読む)
getGoalTree(goalId: string): Promise<GoalTree | null>

// ゴールツリー全体の保存 (アトミック書き込み)
saveGoalTree(tree: GoalTree): Promise<void>

// 個別ゴールノードの取得 (tree.nodes[nodeId])
getGoalNode(goalId: string, nodeId: string): Promise<Goal | null>

// 個別ゴールノードの更新 (tree を読んで nodes を更新してアトミック保存)
updateGoalNode(goalId: string, nodeId: string, updates: Partial<Goal>): Promise<void>

// 新規ゴールノードの追加 (tree を読んで nodes に追加してアトミック保存)
addGoalNode(goalId: string, node: Goal): Promise<void>

// ゴールを root として新規ゴールツリーを作成
createGoalTree(rootGoal: Goal): Promise<GoalTree>

// アクティブなルートゴールの ID 一覧を返す
// 備考: goals/ ディレクトリのサブディレクトリ一覧から取得
listActiveGoalIds(): Promise<string[]>
```

#### 観測ログ操作

```typescript
// 観測ログ全体の取得
getObservationLog(goalId: string): Promise<ObservationLog | null>

// 観測エントリを1件追記 (append-friendly: エントリを末尾に追加してアトミック保存)
appendObservationEntry(goalId: string, entry: ObservationLogEntry): Promise<void>

// 特定次元の最新観測エントリを取得
getLatestObservation(goalId: string, dimensionName: string): Promise<ObservationLogEntry | null>

// observation_id で特定エントリを取得 (Dimension.history の source_observation_id 解決用)
getObservationById(goalId: string, observationId: string): Promise<ObservationLogEntry | null>
```

#### ギャップ履歴操作

```typescript
// 最新の GapVector を取得
getLatestGapVector(goalId: string): Promise<GapVector | null>

// GapVector スナップショットを追記 (各ループ反復後に呼ぶ)
appendGapSnapshot(goalId: string, snapshot: GapVector): Promise<void>

// 直近 N 件の GapVector を取得 (停滞検知用)
getRecentGapVectors(goalId: string, n: number): Promise<GapVector[]>
```

#### タスク操作

```typescript
// タスクの取得
getTask(taskId: string): Promise<Task | null>

// タスクの保存 (作成 + 更新共通、アトミック書き込み)
saveTask(task: Task): Promise<void>

// タスクの部分更新 (実行状態の更新など)
updateTask(taskId: string, updates: Partial<Task>): Promise<void>

// 特定ゴールの全タスク ID を取得
// 備考: tasks/ ディレクトリをスキャンして goal_id でフィルタ
listTaskIdsByGoal(goalId: string): Promise<string[]>
```

#### タスク結果操作

```typescript
// タスク結果の保存
saveTaskResult(result: TaskResult): Promise<void>

// タスク結果の取得
getTaskResult(taskId: string): Promise<TaskResult | null>
```

#### 戦略操作

```typescript
// ポートフォリオ (Portfolio) の取得
getPortfolio(goalId: string): Promise<Portfolio | null>

// ポートフォリオの保存
savePortfolio(portfolio: Portfolio): Promise<void>

// 戦略の更新 (portfolio を読んで該当戦略を更新してアトミック保存)
updateStrategy(goalId: string, strategyId: string, updates: Partial<Strategy>): Promise<void>
```

#### トラスト操作

```typescript
// TrustState の取得
getTrustState(): Promise<TrustState>

// TrustState の保存
saveTrustState(state: TrustState): Promise<void>

// ドメインのトラストバランス更新 (成功: +Δs、失敗: -Δf、境界クランプ込み)
updateTrustBalance(domain: string, delta: number): Promise<TrustBalance>
```

#### イベントキュー操作

```typescript
// 未処理イベントをタイムスタンプ順で取得
getPendingEvents(): Promise<MotivationEvent[]>

// イベントを archive/ に移動 (処理済みマーク)
archiveEvent(filename: string): Promise<void>

// イベントをキューに書き込む (外部からの書き込みは想定しないが内部テスト用)
writeEvent(event: MotivationEvent): Promise<void>
```

#### レポート操作

```typescript
// レポートインデックスの取得
getReportIndex(): Promise<ReportRecord[]>

// レポートファイルの保存 (Markdown 本文 + インデックス更新)
saveReport(record: ReportRecord, markdownContent: string): Promise<void>

// 未読レポートの取得
getUnreadReports(): Promise<ReportRecord[]>

// レポートを既読にマーク
markReportAsRead(reportId: string): Promise<void>
```

#### ネゴシエーションログ操作

```typescript
// ネゴシエーションログの取得
getNegotiationLog(goalId: string): Promise<GoalNegotiationLog | null>

// ネゴシエーションログの保存
saveNegotiationLog(goalId: string, log: GoalNegotiationLog): Promise<void>
```

### B-4. StateManager クラスの公開 API シグネチャ (完全版)

```typescript
// src/state/StateManager.ts

export class StateManager {
  constructor(baseDir?: string); // デフォルト: ~/.motiva/

  // ゴールツリー
  getGoalTree(goalId: string): Promise<GoalTree | null>;
  saveGoalTree(tree: GoalTree): Promise<void>;
  getGoalNode(goalId: string, nodeId: string): Promise<Goal | null>;
  updateGoalNode(goalId: string, nodeId: string, updates: Partial<Goal>): Promise<void>;
  addGoalNode(goalId: string, node: Goal): Promise<void>;
  createGoalTree(rootGoal: Goal): Promise<GoalTree>;
  listActiveGoalIds(): Promise<string[]>;

  // 観測ログ
  getObservationLog(goalId: string): Promise<ObservationLog | null>;
  appendObservationEntry(goalId: string, entry: ObservationLogEntry): Promise<void>;
  getLatestObservation(goalId: string, dimensionName: string): Promise<ObservationLogEntry | null>;
  getObservationById(goalId: string, observationId: string): Promise<ObservationLogEntry | null>;

  // ギャップ履歴
  getLatestGapVector(goalId: string): Promise<GapVector | null>;
  appendGapSnapshot(goalId: string, snapshot: GapVector): Promise<void>;
  getRecentGapVectors(goalId: string, n: number): Promise<GapVector[]>;

  // タスク
  getTask(taskId: string): Promise<Task | null>;
  saveTask(task: Task): Promise<void>;
  updateTask(taskId: string, updates: Partial<Task>): Promise<void>;
  listTaskIdsByGoal(goalId: string): Promise<string[]>;
  saveTaskResult(result: TaskResult): Promise<void>;
  getTaskResult(taskId: string): Promise<TaskResult | null>;

  // 戦略
  getPortfolio(goalId: string): Promise<Portfolio | null>;
  savePortfolio(portfolio: Portfolio): Promise<void>;
  updateStrategy(goalId: string, strategyId: string, updates: Partial<Strategy>): Promise<void>;

  // トラスト
  getTrustState(): Promise<TrustState>;
  saveTrustState(state: TrustState): Promise<void>;
  updateTrustBalance(domain: string, delta: number): Promise<TrustBalance>;

  // イベントキュー
  getPendingEvents(): Promise<MotivationEvent[]>;
  archiveEvent(filename: string): Promise<void>;
  writeEvent(event: MotivationEvent): Promise<void>;

  // レポート
  getReportIndex(): Promise<ReportRecord[]>;
  saveReport(record: ReportRecord, markdownContent: string): Promise<void>;
  getUnreadReports(): Promise<ReportRecord[]>;
  markReportAsRead(reportId: string): Promise<void>;

  // ネゴシエーション
  getNegotiationLog(goalId: string): Promise<GoalNegotiationLog | null>;
  saveNegotiationLog(goalId: string, log: GoalNegotiationLog): Promise<void>;

  // ユーティリティ
  // baseDir 配下の全ディレクトリを初期化 (初回起動時)
  initialize(): Promise<void>;
}
```

---

## C. GapCalculator 仕様

### C-1. パイプライン概要

```
入力: Dimension (current_value, threshold, confidence, uncertainty_weight?)
  ↓
Step 1: calculateRawGap()
  → RawGap (raw_gap, is_null_guard)
  ↓
Step 2: normalizeGap()
  → NormalizedGap (normalized_gap ∈ [0, 1])
  ↓
Step 3: applyConfidenceWeight()
  → WeightedGap (normalized_weighted_gap)
  ↓
全次元の WeightedGap → GapVector.gaps
  ↓
aggregateGapVector()
  → GapVector.aggregated_gap (ボトルネック集約デフォルト)
```

### C-2. Step 1: calculateRawGap()

#### 公式 (gap-calculation.md §1)

```
min(N) 型:
  raw_gap = max(0, threshold.value - current_value)
  ※ current_value が null の場合: raw_gap = threshold.value, is_null_guard = true

max(N) 型:
  raw_gap = max(0, current_value - threshold.value)
  ※ current_value が null の場合: raw_gap = threshold.value, is_null_guard = true

range(low, high) 型:
  raw_gap = max(0, threshold.low - current_value) + max(0, current_value - threshold.high)
  ※ current_value が null の場合: raw_gap = (threshold.high - threshold.low) / 2, is_null_guard = true
  [参考: 設計ドキュメントに null 時の range 型デフォルト値の明示なし → レンジ幅の半分を最大ギャップとして使用]

present 型:
  raw_gap = 対象が存在する: 0, 存在しない: 1
  ※ current_value が null の場合: raw_gap = 1, is_null_guard = true
  [実装注記: current_value === null OR current_value === false → 1, それ以外 → 0]

match(value) 型:
  raw_gap = current_value === threshold.value: 0, それ以外: 1
  ※ current_value が null の場合: raw_gap = 1, is_null_guard = true
```

#### ガード条件

- `current_value === null` → 各型の最大ギャップを返し `is_null_guard = true` を設定する。
- `present` 型: `current_value` が `null`, `false`, `undefined` → 未存在として `raw_gap = 1`。
- `match` 型: 数値・文字列・真偽値の比較には strict equality (`===`) を使用する。

#### メソッドシグネチャ

```typescript
// src/gap/GapCalculator.ts

calculateRawGap(dim: Dimension): RawGap
```

### C-3. Step 2: normalizeGap()

#### 公式 (gap-calculation.md §2)

```
min(N) 型:
  normalize_denominator = threshold.value
  if threshold.value === 0:
    normalized_gap = raw_gap > 0 ? 1.0 : 0.0  // ゼロ除算ガード
  else:
    normalized_gap = raw_gap / threshold.value

max(N) 型:
  normalize_denominator = threshold.value
  if threshold.value === 0:
    normalized_gap = Math.min(1.0, raw_gap)    // ゼロ除算ガード: raw_gap を 1.0 にキャップ
  else:
    normalized_gap = raw_gap / threshold.value

range(low, high) 型:
  half_width = (threshold.high - threshold.low) / 2
  if half_width === 0:
    normalized_gap = raw_gap > 0 ? 1.0 : 0.0  // ゼロ除算ガード (low === high の場合)
  else:
    normalized_gap = Math.min(1.0, raw_gap / half_width)  // 上限 1.0 でキャップ

present 型:
  normalized_gap = raw_gap  // すでに 0 または 1

match 型:
  normalized_gap = raw_gap  // すでに 0 または 1

null guard (is_null_guard = true) の場合:
  normalized_gap = 1.0  // null は最大ギャップ (全型共通)
  → normalizeGap() の先頭でチェックしてショートカット
```

#### ガード条件

- `is_null_guard = true` → `normalized_gap = 1.0` を即座に返す (除算処理なし)。
- `threshold.value === 0` (`min`/`max` 型) → ゼロ除算を回避し、安全なデフォルト値を返す。
- `threshold.low === threshold.high` (`range` 型) → `half_width = 0` になるため、同じくゼロ除算ガードを適用する。
- 最終結果は `normalized_gap ∈ [0.0, 1.0]` に clamp する (`present`/`match` は自然に満たすが、数値型は `Math.min(1.0, ...)` で明示的に clamp する)。

#### メソッドシグネチャ

```typescript
normalizeGap(rawGap: RawGap, threshold: Threshold): NormalizedGap
```

### C-4. Step 3: applyConfidenceWeight()

#### 公式 (gap-calculation.md §3)

```
normalized_weighted_gap =
  normalized_gap × (1 + (1 - confidence) × uncertainty_weight)

ただし is_null_guard = true の場合:
  normalized_weighted_gap = normalized_gap (= 1.0) のまま
  理由: null の場合はすでに最大ギャップとして扱っている。
        信頼度加重で二重に膨らませない (設計ドキュメント §3 明記)

uncertainty_weight の決定ロジック:
  1. dim.uncertainty_weight が設定されている場合: その値を使用 (次元別オーバーライド)
  2. 未設定の場合: globalUncertaintyWeight を使用 (デフォルト: 1.0)
  globalUncertaintyWeight は GapCalculator のコンストラクタ引数またはメソッド引数で渡す
```

#### 動作例 (gap-calculation.md §3 の表より)

| confidence | uncertainty_weight | 増幅率 |
|---|---|---|
| 1.0 | 任意 | 1.0 (変化なし) |
| 0.5 | 1.0 | 1.5倍 |
| 0.0 | 1.0 | 2.0倍 |
| 0.0 | 0.5 | 1.5倍 |

#### メソッドシグネチャ

```typescript
applyConfidenceWeight(
  normalizedGap: NormalizedGap,
  confidence: number,
  uncertaintyWeight: number
): WeightedGap
```

### C-5. aggregateGapVector()

#### 公式 (gap-calculation.md §6)

```
デフォルト (ボトルネック集約 = Max):
  aggregated_gap = max(normalized_weighted_gap(dim_1), ..., normalized_weighted_gap(dim_N))

加重平均集約:
  aggregated_gap = Σ(weight_k × normalized_weighted_gap(dim_k)) / Σ(weight_k)
  重みは Dimension.weight フィールドから取得。未設定の場合は 1.0 とみなす。

MAX 集約:
  aggregated_gap = max(normalized_weighted_gap(...))  (ボトルネックと同じ)
```

注意: `state-vector.md §4` の「最小値集約」と `gap-calculation.md §6` の「ボトルネック集約 (Max)」は、達成度空間とギャップ空間の表現の違いであり、同じ操作を指す (gap-calculation.md §6 に明記)。

#### エッジケース

- `dims` が空の場合: `aggregated_gap = 0.0` を返す (完了扱い)。
- 全次元が `normalized_weighted_gap = 0.0` の場合: ゴール完了。
- `weight` が全次元 0 の加重平均: `aggregated_gap = 0.0` を返す (ゼロ除算ガード)。

#### メソッドシグネチャ

```typescript
aggregateGapVector(
  gaps: WeightedGap[],
  aggregationMethod: AggregationMethod,
  weights?: Record<string, number>  // dimension_name -> weight
): number
```

### C-6. calculateGapVector() — メインエントリポイント

ゴールの 1 次元以上の `Dimension` リストから `GapVector` を一括計算する。

```typescript
calculateGapVector(
  goalId: string,
  iteration: number,
  dimensions: Dimension[],
  aggregationMethod: AggregationMethod,
  globalUncertaintyWeight?: number  // デフォルト: 1.0
): GapVector
```

**実装ステップ:**
1. 各 `Dimension` に対して `calculateRawGap()` → `normalizeGap()` → `applyConfidenceWeight()` を順番に実行
2. `WeightedGap[]` を生成
3. `aggregateGapVector()` で `aggregated_gap` を計算
4. `gap_delta` を計算するために、前回の `GapVector` と比較する (オプション: 呼び出し側が前回値を渡す)
5. `confidence_vector` を生成 (`dimension_name -> confidence`)
6. `GapVector` として返す

**gap_delta の計算 (gap-calculation.md §8):**
```
gap_delta[dim] = prev_gap_vector.gaps[dim].normalized_weighted_gap
               - current_weighted_gap.normalized_weighted_gap
// 正なら改善、負なら悪化
```
前回の `GapVector` が存在しない場合 (`gap_delta` は計算しない → `undefined`)。

### C-7. isGoalComplete() — 完了判定

```typescript
// gap-calculation.md §5: 全次元の normalized_weighted_gap = 0 でゴール完了
isGoalComplete(gapVector: GapVector): boolean
// 実装: gapVector.gaps.every(g => g.normalized_weighted_gap === 0)
```

### C-8. GapCalculator クラスの公開 API シグネチャ (完全版)

```typescript
// src/gap/GapCalculator.ts

export class GapCalculator {
  constructor(globalUncertaintyWeight?: number); // デフォルト: 1.0

  // Step 1
  calculateRawGap(dim: Dimension): RawGap;

  // Step 2
  normalizeGap(rawGap: RawGap, threshold: Threshold): NormalizedGap;

  // Step 3
  applyConfidenceWeight(
    normalizedGap: NormalizedGap,
    confidence: number,
    uncertaintyWeight?: number  // 未指定時: コンストラクタの globalUncertaintyWeight を使用
  ): WeightedGap;

  // 集約
  aggregateGapVector(
    gaps: WeightedGap[],
    aggregationMethod: AggregationMethod,
    weights?: Record<string, number>
  ): number;

  // メインエントリポイント
  calculateGapVector(
    goalId: string,
    iteration: number,
    dimensions: Dimension[],
    aggregationMethod: AggregationMethod,
    previousGapVector?: GapVector
  ): GapVector;

  // 完了判定
  isGoalComplete(gapVector: GapVector): boolean;
}
```

---

## D. ファイル構造

### D-1. 提案する src/ ディレクトリレイアウト

```
src/
├── index.ts                      CLIエントリーポイント (Layer 6: CLIRunner)
│
├── types/                        ★ Stage 1 実装対象
│   ├── index.ts                  全型の re-export
│   ├── enums.ts                  A-1 の全 enum / literal
│   ├── goal.ts                   A-2 の全ゴール型
│   ├── state.ts                  A-3 の観測ログ型
│   ├── gap.ts                    A-4 の全ギャップ型
│   ├── trust.ts                  A-5 の全トラスト型
│   ├── task.ts                   A-6 の全タスク型
│   ├── session.ts                A-7 の全セッション型
│   ├── strategy.ts               A-8 の全戦略型
│   ├── drive.ts                  A-9 の全駆動型
│   └── report.ts                 A-10 の全レポート型
│
├── state/                        ★ Stage 1 実装対象
│   ├── StateManager.ts           StateManager クラス (B-4 の API)
│   └── __tests__/
│       └── StateManager.test.ts
│
├── gap/                          ★ Stage 1 実装対象
│   ├── GapCalculator.ts          GapCalculator クラス (C-8 の API)
│   └── __tests__/
│       └── GapCalculator.test.ts
│
├── drive/                        Layer 1: DriveSystem (Stage 2)
│   └── DriveSystem.ts
│
├── trust/                        Layer 1: TrustManager (Stage 2)
│   └── TrustManager.ts
│
├── observation/                  Layer 2: ObservationEngine (Stage 3)
│   └── ObservationEngine.ts
│
├── scoring/                      Layer 2: DriveScorer (Stage 3)
│   └── DriveScorer.ts
│
├── satisficing/                  Layer 2: SatisficingJudge (Stage 3)
│   └── SatisficingJudge.ts
│
├── stall/                        Layer 2: StallDetector (Stage 3)
│   └── StallDetector.ts
│
├── session/                      Layer 3: SessionManager (Stage 4)
│   └── SessionManager.ts
│
├── goal/                         Layer 3: GoalNegotiator (Stage 4)
│   └── GoalNegotiator.ts
│
├── strategy/                     Layer 3: StrategyManager (Stage 4)
│   └── StrategyManager.ts
│
├── task/                         Layer 4: TaskLifecycle (Stage 5)
│   └── TaskLifecycle.ts
│
├── core/                         Layer 5: CoreLoop (Stage 6)
│   └── CoreLoop.ts
│
├── reporting/                    Layer 5: ReportingEngine (Stage 6)
│   └── ReportingEngine.ts
│
└── adapters/                     Layer 0: AdapterLayer (Stage 1 or 2)
    ├── types.ts                  Adapter インターフェース型
    ├── claude-code.ts            Claude Code CLI アダプター
    └── claude-api.ts             Claude API アダプター (将来)
```

### D-2. 型ファイルの責務分担

| ファイル | 含まれる型 | 依存する型ファイル |
|---|---|---|
| `types/enums.ts` | 全 enum / literal / 定数 | なし |
| `types/goal.ts` | Threshold, ObservationMethod, HistoryEntry, DimensionMapping, Dimension, StateVector, Constraint, MilestoneSpecificFields, Goal, GoalTree, GoalNegotiationLog | enums.ts |
| `types/state.ts` | ObservationLogEntry, ObservationLog | enums.ts |
| `types/gap.ts` | RawGap, NormalizedGap, WeightedGap, GapVector | enums.ts |
| `types/trust.ts` | TrustBalance, TrustState, ConfidenceLevel, Quadrant, CONFIDENCE_THRESHOLD (定数) | enums.ts |
| `types/task.ts` | Duration, Criterion, ScopeBoundary, ExecutionState, Task, Evidence, DimensionUpdate, ReviewerSessionOutput, ExecutorReport, TaskResult | enums.ts, goal.ts |
| `types/session.ts` | ContextItem, SessionRecord | enums.ts |
| `types/strategy.ts` | ResourceEstimate, ExpectedEffect, Strategy, Portfolio | enums.ts, task.ts |
| `types/drive.ts` | DriveScores, MotivationEvent | enums.ts |
| `types/report.ts` | ReportRecord | enums.ts |
| `types/index.ts` | 全型を re-export | 上記全ファイル |

### D-3. Stage 1 の実装範囲と優先順位

**必須 (Stage 1 完了の条件):**
1. `src/types/` 全ファイル — Zod スキーマと TypeScript 型の定義
2. `src/state/StateManager.ts` — ファイル I/O、アトミック書き込み、CRUD 全操作
3. `src/gap/GapCalculator.ts` — 3ステップパイプライン、集約、完了判定

**テスト要件:**
- `GapCalculator.test.ts`: 各閾値型 × null/zero-division/通常の組み合わせ → 数値の正確性を検証
- `StateManager.test.ts`: 各 CRUD 操作の read-write roundtrip → アトミック性の確認

**Stage 1 で実装しない (後続 Stage に委譲):**
- LLM 呼び出し (GoalNegotiator, ObservationEngine など)
- DriveScorer (計算式は型定義のみ)
- アダプター (interface 定義のみ)
- CoreLoop

---

## E. 設計上の補足・実装注意事項

### E-1. GapCalculator の信頼度加重 — 3重適用の回避

gap-calculation.md §3 の明記に従い、信頼度調整の適用箇所は GapCalculator の Step 3 (`applyConfidenceWeight()`) のみとする。

- `observation.md §4` の進捗上限ルール (70%/90%/100%) は **ObservationEngine** が担当する入力フィルターであり、GapCalculator は一切関知しない。
- `state-vector.md §6` の有効達成度 (`達成度 × confidence`) はレポーティング・表示用の参考値であり、GapCalculator のパイプラインには入らない。
- GapCalculator は `StateVector.dimensions[*].confidence` をそのまま受け取り、Step 3 で 1 回だけ加重を適用する。

### E-2. null 型の current_value 判定

TypeScript で `null`, `undefined`, `false`, `0` を区別する必要がある。

- `present` 型: `current_value === null || current_value === undefined || current_value === false` → 未存在 (raw_gap = 1)。`current_value === 0` は「存在するが値が0」なので存在として扱う (raw_gap = 0)。
- `match` 型: `current_value === null` は初期状態 (is_null_guard = true)。それ以外は strict equality で比較。
- `min`/`max`/`range` 型: `current_value === null` は is_null_guard = true。`current_value === 0` は正常な数値として扱う。

### E-3. StateManager のファイルパス解決

`~` の展開には Node.js の `os.homedir()` を使用する。`baseDir` のデフォルトは `path.join(os.homedir(), '.motiva')` とする。テスト時は `baseDir` に一時ディレクトリを渡すことで本番ファイルを汚染しない。

### E-4. Zod の discriminatedUnion と parse エラー

`ThresholdSchema` は `z.discriminatedUnion('type', [...])` を使用するため、`type` フィールドが一致しない場合は Zod が明確なエラーメッセージを生成する。`z.union` よりパフォーマンスと型推論が良い。

### E-5. 循環参照の回避

`Goal` 型は `children: z.array(z.string())` (ID 参照のみ) を持ち、`GoalTree.nodes` に全ノードを格納する設計とする。これにより Zod スキーマに循環参照が生じない。`z.lazy()` は使用しない。

### E-6. tsconfig との整合性

- `"module": "Node16"` — `.js` 拡張子付きの import が必要。例: `import { Dimension } from './types/goal.js'`
- `"strict": true` — `noImplicitAny` が有効。`z.unknown()` を使う箇所は意図を明示するコメントを付ける。
- `"resolveJsonModule": true` — JSON ファイルの直接 import が可能 (設定ファイル読み込み時に活用)。

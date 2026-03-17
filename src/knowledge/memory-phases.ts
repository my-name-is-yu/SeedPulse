/**
 * memory-phases.ts — backward-compatibility re-export barrel.
 *
 * All implementations have been extracted into focused modules:
 *   - memory-index.ts   — index management + lesson storage
 *   - memory-stats.ts   — statistics computation
 *   - memory-query.ts   — lesson query / retrieval
 *   - memory-distill.ts — LLM pattern extraction + distillation
 */

export {
  initializeIndex,
  loadIndex,
  saveIndex,
  updateIndex,
  removeFromIndex,
  removeGoalFromIndex,
  touchIndexEntry,
  archiveOldestLongTermEntries,
  storeLessonsLongTerm,
} from "./memory-index.js";

export {
  updateStatistics,
  mergeTaskStats,
  mergeDimStats,
  computeTrend,
  computePeriod,
} from "./memory-stats.js";

export {
  queryLessons,
  queryCrossGoalLessons,
} from "./memory-query.js";

export {
  extractPatterns,
  distillLessons,
  validateCompressionQuality,
} from "./memory-distill.js";

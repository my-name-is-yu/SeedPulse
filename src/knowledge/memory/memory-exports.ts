// Barrel: re-exports from memory sub-modules
export type {
  ShortTermEntry,
  LessonEntry,
  StatisticalSummary,
  MemoryIndex,
  CompressionResult,
  RetentionConfig,
  MemoryDataType,
} from "../types/memory-lifecycle.js";

export {
  extractPatterns,
  distillLessons,
  validateCompressionQuality,
} from "./memory-distill.js";
export { updateStatistics, mergeTaskStats, mergeDimStats, computeTrend, computePeriod } from "./memory-stats.js";
export { storeLessonsLongTerm, loadIndex, saveIndex, updateIndex, removeFromIndex, removeGoalFromIndex, touchIndexEntry, archiveOldestLongTermEntries, initializeIndex } from "./memory-index.js";
export { queryLessons, queryCrossGoalLessons } from "./memory-query.js";

export {
  atomicWriteAsync,
  readJsonFileAsync,
  getDataFile,
  generateId,
  getDirectorySizeAsync,
  getRetentionLimit,
} from "./memory-persistence.js";

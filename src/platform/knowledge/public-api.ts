export {
  searchKnowledge,
  searchAcrossGoals,
  searchByEmbedding,
  querySharedKnowledge,
} from "./knowledge-search.js";

export {
  classifyDomainStability,
  getStaleEntries,
  generateRevalidationTasks,
  computeRevalidationDue,
} from "./knowledge-revalidation.js";

export { detectKnowledgeGap, generateAcquisitionTask, checkContradiction } from "./knowledge-manager-query.js";

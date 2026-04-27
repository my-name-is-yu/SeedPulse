export {
  gatherResidentWorkspaceContext,
  loadExistingGoalTitles,
  loadKnownGoals,
  persistResidentActivity,
  resolveResidentWorkspaceDir,
  type DaemonRunnerResidentContext,
} from "./runner-resident-shared.js";

export {
  runResidentCuriosityCycle,
  runScheduledGoalReview,
  triggerResidentGoalDiscovery,
  triggerResidentInvestigation,
} from "./runner-resident-curiosity.js";

export {
  legacyReportFromPlatformDream,
  runDreamAnalysis,
  runPlatformDreamConsolidation,
  triggerIdleResidentMaintenance,
  triggerResidentDreamMaintenance,
  tryApplyPendingDreamSuggestion,
} from "./runner-resident-dream.js";

export {
  proactiveTick,
  triggerResidentPreemptiveCheck,
} from "./runner-resident-proactive.js";

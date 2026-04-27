import { CapabilityAcquisitionTaskSchema } from "../../../base/types/capability.js";
import type {
  CapabilityAcquisitionTask,
  CapabilityGap,
} from "../../../base/types/capability.js";
import {
  ACQUISITION_RECOMMENDATION_RULES,
  type CapabilityAcquisitionRecommendation,
} from "./types.js";

export function recommendAcquisition(gap: CapabilityGap): CapabilityAcquisitionRecommendation[] {
  const haystack = [
    gap.missing_capability.name,
    gap.reason,
    gap.impact_description,
    ...gap.alternatives,
  ].join(" ");

  return ACQUISITION_RECOMMENDATION_RULES
    .filter((rule) =>
      rule.capabilityTypes.includes(gap.missing_capability.type) &&
      rule.patterns.some((pattern) => pattern.test(haystack))
    )
    .map((rule) => ({
      pluginName: rule.pluginName,
      installSource: rule.installSource,
      rationale: rule.rationale,
      verificationHint: rule.verificationHint,
      requiresApproval: rule.requiresApproval,
    }));
}

export function planAcquisitionTask(
  gap: CapabilityGap,
  recommendation?: CapabilityAcquisitionRecommendation
): CapabilityAcquisitionTask {
  const capabilityName = gap.missing_capability.name;
  const capabilityType = gap.missing_capability.type;

  let method: CapabilityAcquisitionTask["method"];
  let taskDescription: string;

  if (capabilityType === "tool") {
    method = "tool_creation";
    taskDescription =
      `Create a tool named "${capabilityName}" that fulfills the following need: ${gap.reason}. ` +
      `The tool should be implemented and made available for use. ` +
      `Impact if unavailable: ${gap.impact_description}`;
  } else if (capabilityType === "permission") {
    method = "permission_request";
    taskDescription =
      `Request permission for "${capabilityName}" from the user or system administrator. ` +
      `Reason the permission is needed: ${gap.reason}. ` +
      `Impact if unavailable: ${gap.impact_description}`;
  } else if (capabilityType === "service") {
    method = "service_setup";
    taskDescription =
      `Set up the service "${capabilityName}" required for the following reason: ${gap.reason}. ` +
      `Configure and verify the service is operational. ` +
      `Impact if unavailable: ${gap.impact_description}`;
  } else {
    method = "service_setup";
    taskDescription =
      `Set up access to the data source "${capabilityName}" required for the following reason: ${gap.reason}. ` +
      `Configure and verify the data source is accessible. ` +
      `Impact if unavailable: ${gap.impact_description}`;
  }

  if (recommendation) {
    taskDescription +=
      ` Recommended acquisition path: install plugin "${recommendation.pluginName}" from ` +
      `"${recommendation.installSource}". ${recommendation.rationale} ` +
      `Verification hint: ${recommendation.verificationHint}`;
  }

  const successCriteria = [
    "capability registered in registry",
    `${capabilityName} is operational and accessible`,
  ];
  if (recommendation) {
    successCriteria.push(
      `recommended plugin "${recommendation.pluginName}" is installed or otherwise made available`,
      "follow-up replanning is triggered after the capability becomes available"
    );
  }

  return CapabilityAcquisitionTaskSchema.parse({
    gap,
    method,
    task_description: taskDescription,
    success_criteria: successCriteria,
    verification_attempts: 0,
    max_verification_attempts: 3,
  });
}

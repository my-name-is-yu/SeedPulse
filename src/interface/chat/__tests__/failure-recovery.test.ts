import { describe, expect, it } from "vitest";
import { classifyFailureRecovery, formatLifecycleFailureMessage } from "../failure-recovery.js";

describe("failure recovery guidance", () => {
  it("classifies verification failures with review guidance", () => {
    const guidance = classifyFailureRecovery("Changes applied but tests are still failing after 2 retries.");

    expect(guidance.kind).toBe("verification");
    expect(guidance.label).toBe("Verification failure");
    expect(guidance.nextActions.join("\n")).toContain("/review");
  });

  it("classifies missing resumable state with session guidance", () => {
    const guidance = classifyFailureRecovery("No resumable native agentloop state found.");

    expect(guidance.kind).toBe("resume");
    expect(guidance.nextActions.join("\n")).toContain("/sessions");
    expect(guidance.nextActions.join("\n")).toContain("/resume <id|title>");
  });

  it("formats lifecycle errors without hiding the original interruption", () => {
    const text = formatLifecycleFailureMessage("stream aborted", "Partial answer");

    expect(text).toContain("Partial answer");
    expect(text).toContain("[interrupted: stream aborted]");
    expect(text).toContain("Type: Runtime interruption");
    expect(text).toContain("Next actions:");
  });
});

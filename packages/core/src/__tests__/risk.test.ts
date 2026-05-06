import { describe, expect, it } from "vitest";
import { actionPriority, classifyActionRisk } from "../actions/risk.js";
import type { CandidateAction } from "../types.js";

describe("action risk classification", () => {
  it("blocks destructive labels", () => {
    expect(classifyActionRisk({ type: "click", label: "Delete workspace" }).risk).toBe("blocked");
  });

  it("marks submit-like labels as caution", () => {
    expect(classifyActionRisk({ type: "click", label: "Continue to payment" }).risk).toBe("caution");
  });

  it("prioritizes product-surface revealing actions", () => {
    const checkout: CandidateAction = {
      id: "a1",
      stateId: "s1",
      type: "click",
      selector: "#checkout",
      label: "Checkout",
      role: "button",
      risk: "caution",
      reason: "submit",
      score: 0
    };
    const inert: CandidateAction = {
      ...checkout,
      id: "a2",
      selector: "#details",
      label: "Details",
      risk: "safe"
    };
    expect(actionPriority(checkout)).toBeGreaterThan(actionPriority(inert));
  });
});

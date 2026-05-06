import { describe, expect, it } from "vitest";
import { generateBuildQualityScoreboard } from "../quality/scoreboard.js";
import { generateFindingsMarkdown } from "../report/markdown.js";
import type { CartographRun, DomSummary, UIFinding, UIState, UITransition } from "../types.js";

function summary(overrides: Partial<DomSummary["metrics"]> = {}): DomSummary {
  return {
    headings: ["Checkout"],
    visibleTextSample: ["Checkout", "Payment"],
    roles: { button: 2 },
    forms: [],
    buttons: [],
    links: [],
    inputs: [],
    dialogs: [],
    metrics: {
      elementCount: 30,
      visibleTextLength: 180,
      scrollWidth: 1440,
      clientWidth: 1440,
      overflowX: 0,
      duplicateIdCount: 0,
      unnamedButtonCount: 0,
      unlabeledInputCount: 0,
      offscreenInteractiveCount: 0,
      textOverflowCount: 0,
      mainBlank: false,
      disabledSubmitLikeCount: 0,
      ...overrides
    }
  };
}

function state(id: string, viewport: "desktop" | "mobile" = "desktop", domSummary = summary()): UIState {
  return {
    id,
    viewport,
    url: "http://localhost:3000/checkout",
    title: "Checkout",
    label: "Checkout",
    fingerprint: {
      urlKey: "http://localhost:3000/checkout",
      textHash: id,
      domHash: id,
      roleHash: id,
      visualHash: id,
      viewportKey: viewport
    },
    screenshotPath: `screenshots/${id}.png`,
    domSummary,
    interactiveCount: 2,
    consoleErrors: [],
    networkErrors: [],
    replayPath: [{ type: "goto", url: "http://localhost:3000/checkout" }]
  };
}

function finding(id: string, detector: string, severity: "info" | "warning" | "critical", stateId: string, selector = "#apply"): UIFinding {
  return {
    id,
    detector,
    severity,
    title: detector,
    detail: `${detector} detail`,
    stateId,
    selector,
    screenshotPath: `screenshots/${stateId}.png`,
    evidence: [],
    replayPath: [
      { type: "goto", url: "http://localhost:3000/checkout" },
      { type: "click", selector, label: "Apply" }
    ]
  };
}

function transition(id: string, status: UITransition["status"]): UITransition {
  return {
    id,
    fromStateId: "s1",
    toStateId: "s2",
    actionId: `a-${id}`,
    action: {
      id: `a-${id}`,
      stateId: "s1",
      type: "click",
      selector: "#apply",
      label: "Apply",
      risk: "safe",
      reason: "test",
      score: 10
    },
    durationMs: 12,
    status,
    screenshotBeforePath: "screenshots/s1.png",
    screenshotAfterPath: "screenshots/s2.png"
  };
}

function run(overrides: Partial<CartographRun> = {}): CartographRun {
  const states = [state("s1"), state("s2", "mobile")];
  const transitions = [transition("t1", "changed")];
  return {
    id: "quality-test",
    startUrl: "http://localhost:3000",
    createdAt: "2026-05-05T00:00:00.000Z",
    options: {
      maxActions: 20,
      maxDepth: 4,
      maxDurationMs: 20_000,
      viewports: [
        { name: "desktop", width: 1440, height: 900 },
        { name: "mobile", width: 390, height: 844 }
      ],
      allowExternal: false,
      allowSubmit: true,
      sameOriginOnly: true,
      denyActionLabels: [],
      allowActionLabels: [],
      outputDir: ".cartograph/runs/quality-test",
      headed: false
    },
    summary: {
      id: "quality-test",
      startUrl: "http://localhost:3000",
      createdAt: "2026-05-05T00:00:00.000Z",
      status: "completed",
      durationMs: 1200,
      stateCount: states.length,
      transitionCount: transitions.length,
      findingCount: 0,
      actionsAttempted: transitions.length,
      viewports: ["desktop", "mobile"],
      issuesBySeverity: { info: 0, warning: 0, critical: 0 }
    },
    states,
    transitions,
    findings: [],
    assets: [],
    ...overrides
  };
}

describe("build quality scoreboard", () => {
  it("maps findings to category scores and computes the weighted overall score", () => {
    const subject = run({
      findings: [
        finding("f-network", "network-error", "critical", "s2"),
        finding("f-overflow", "horizontal-overflow", "warning", "s2", "#checkout"),
        finding("f-a11y", "accessibility-smoke", "warning", "s1", "#name")
      ],
      summary: { ...run().summary, findingCount: 3, issuesBySeverity: { info: 0, warning: 2, critical: 1 } }
    });

    const quality = generateBuildQualityScoreboard(subject, "2026-05-05T00:00:01.000Z");
    const error = quality.categories.find((category) => category.id === "error_health");
    const responsive = quality.categories.find((category) => category.id === "responsive_health");
    const accessibility = quality.categories.find((category) => category.id === "accessibility_smoke");
    const expectedOverall = Math.round(quality.categories.reduce((sum, category) => sum + category.score * category.weight, 0));

    expect(error?.evidenceFindingIds).toContain("f-network");
    expect(responsive?.evidenceFindingIds).toContain("f-overflow");
    expect(accessibility?.evidenceFindingIds).toContain("f-a11y");
    expect(quality.overallScore).toBe(expectedOverall);
    expect(quality.topRisks[0]?.findingIds).toContain("f-network");
  });

  it("reduces repeat penalties for duplicate root findings", () => {
    const subject = run({
      findings: [
        finding("f-network-1", "network-error", "critical", "s1", "#apply"),
        finding("f-network-2", "network-error", "critical", "s1", "#apply")
      ],
      summary: { ...run().summary, findingCount: 2, issuesBySeverity: { info: 0, warning: 0, critical: 2 } }
    });

    const quality = generateBuildQualityScoreboard(subject, "2026-05-05T00:00:01.000Z");
    const error = quality.categories.find((category) => category.id === "error_health");

    expect(error?.score).toBe(76);
  });

  it("marks stopped or budget-limited crawls as state coverage risk", () => {
    const base = run();
    const quality = generateBuildQualityScoreboard(
      run({
        summary: { ...base.summary, status: "stopped", actionsAttempted: 20 },
        transitions: Array.from({ length: 20 }, (_, index) => transition(`t${index}`, "changed"))
      }),
      "2026-05-05T00:00:01.000Z"
    );
    const coverage = quality.categories.find((category) => category.id === "state_coverage");

    expect(coverage?.summary).toContain("partial reachable-state coverage");
    expect(quality.topRisks.some((risk) => risk.categoryId === "state_coverage")).toBe(true);
  });

  it("includes the scoreboard in markdown findings export", () => {
    const subject = run();
    subject.quality = generateBuildQualityScoreboard(subject, "2026-05-05T00:00:01.000Z");

    expect(generateFindingsMarkdown(subject)).toContain("## Build Quality Scoreboard");
    expect(generateFindingsMarkdown(subject)).toContain("Overall:");
  });
});

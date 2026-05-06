import { describe, expect, it } from "vitest";
import { runDetectors } from "../detectors/index.js";
import type { CrawlOptions, DomSummary, UIState, UITransition } from "../types.js";

const options: CrawlOptions = {
  maxActions: 20,
  maxDepth: 4,
  maxDurationMs: 20_000,
  viewports: [{ name: "desktop", width: 1440, height: 900 }],
  allowExternal: false,
  allowSubmit: false,
  sameOriginOnly: true,
  denyActionLabels: [],
  allowActionLabels: [],
  outputDir: ".cartograph/runs/test",
  headed: false
};

function summary(overrides: Partial<DomSummary["metrics"]> = {}): DomSummary {
  return {
    headings: ["Settings"],
    visibleTextSample: ["Settings", "Billing"],
    roles: { button: 1 },
    forms: [],
    buttons: [{ selector: "#close", label: "Close", tagName: "button", role: "button" }],
    links: [],
    inputs: [],
    dialogs: [],
    metrics: {
      elementCount: 20,
      visibleTextLength: 120,
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

function state(id: string, overrides: Partial<UIState> = {}): UIState {
  return {
    id,
    viewport: "desktop",
    url: "http://localhost:3000",
    title: "Demo",
    label: "Settings",
    fingerprint: {
      urlKey: "http://localhost:3000/",
      textHash: "text",
      domHash: "dom",
      roleHash: "role",
      visualHash: "visual",
      viewportKey: "desktop"
    },
    screenshotPath: "screenshots/state.png",
    domSummary: summary(),
    interactiveCount: 1,
    consoleErrors: [],
    networkErrors: [],
    replayPath: [{ type: "goto", url: "http://localhost:3000" }],
    ...overrides
  };
}

describe("detectors", () => {
  it("reports no-effect clicks and modal close failures", async () => {
    const before = state("s1", { domSummary: { ...summary(), dialogs: [{ selector: "#modal", label: "Create", tagName: "section", role: "dialog" }] } });
    const after = state("s1", { domSummary: { ...summary(), dialogs: [{ selector: "#modal", label: "Create", tagName: "section", role: "dialog" }] } });
    const transition: UITransition = {
      id: "t1",
      fromStateId: "s1",
      toStateId: "s1",
      actionId: "a1",
      action: {
        id: "a1",
        stateId: "s1",
        type: "click",
        selector: "#close",
        label: "Close",
        role: "button",
        risk: "safe",
        reason: "test",
        score: 1
      },
      durationMs: 10,
      status: "no_effect",
      screenshotBeforePath: "screenshots/before.png",
      screenshotAfterPath: "screenshots/after.png"
    };
    const findings = await runDetectors({ before, after, transition, options });
    expect(findings.map((finding) => finding.detector)).toEqual(expect.arrayContaining(["no-effect-click", "modal-cannot-close"]));
  });

  it("reports network errors and horizontal overflow", async () => {
    const after = state("s2", {
      domSummary: summary({ overflowX: 220, scrollWidth: 1660 }),
      networkErrors: [{ method: "POST", url: "http://localhost:3000/api/promo", status: 500, timestamp: new Date().toISOString() }]
    });
    const findings = await runDetectors({ after, options });
    expect(findings.map((finding) => finding.detector)).toEqual(expect.arrayContaining(["network-error", "horizontal-overflow"]));
  });
});

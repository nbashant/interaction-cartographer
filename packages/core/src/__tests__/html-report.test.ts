import { describe, expect, it } from "vitest";
import { generateStaticHtmlReport } from "../report/html.js";
import type { CartographRun, DomSummary, UIState } from "../types.js";

function domSummary(): DomSummary {
  return {
    headings: ["Unsafe"],
    visibleTextSample: ["Unsafe"],
    roles: {},
    forms: [],
    buttons: [],
    links: [],
    inputs: [],
    dialogs: [],
    metrics: {
      elementCount: 1,
      visibleTextLength: 6,
      scrollWidth: 100,
      clientWidth: 100,
      overflowX: 0,
      duplicateIdCount: 0,
      unnamedButtonCount: 0,
      unlabeledInputCount: 0,
      offscreenInteractiveCount: 0,
      textOverflowCount: 0,
      mainBlank: false,
      disabledSubmitLikeCount: 0
    }
  };
}

function state(): UIState {
  return {
    id: "s1",
    viewport: "desktop",
    url: "http://localhost:3000",
    title: "Unsafe",
    label: `<img src=x onerror=alert("state")>`,
    fingerprint: {
      urlKey: "http://localhost:3000",
      textHash: "text",
      domHash: "dom",
      roleHash: "role",
      visualHash: "visual",
      viewportKey: "desktop"
    },
    screenshotPath: "screenshots/state.png",
    domSummary: domSummary(),
    interactiveCount: 0,
    consoleErrors: [],
    networkErrors: [],
    replayPath: [{ type: "goto", url: "http://localhost:3000" }]
  };
}

describe("static html report", () => {
  it("does not render crawl-derived labels and findings through innerHTML", () => {
    const run: CartographRun = {
      id: "html-test",
      startUrl: "http://localhost:3000",
      createdAt: "2026-05-06T00:00:00.000Z",
      options: {
        maxActions: 1,
        maxDepth: 1,
        maxDurationMs: 1000,
        viewports: [{ name: "desktop", width: 1440, height: 900 }],
        allowExternal: false,
        allowSubmit: true,
        sameOriginOnly: true,
        denyActionLabels: [],
        allowActionLabels: [],
        outputDir: ".cartograph/runs/html-test",
        headed: false
      },
      summary: {
        id: "html-test",
        startUrl: "http://localhost:3000",
        createdAt: "2026-05-06T00:00:00.000Z",
        status: "completed",
        durationMs: 100,
        stateCount: 1,
        transitionCount: 0,
        findingCount: 1,
        actionsAttempted: 0,
        viewports: ["desktop"],
        issuesBySeverity: { info: 0, warning: 1, critical: 0 }
      },
      states: [state()],
      transitions: [],
      findings: [
        {
          id: "f1",
          severity: "warning",
          detector: "unsafe",
          title: `<svg onload=alert("finding")>`,
          detail: `<script>alert("detail")</script>`,
          stateId: "s1",
          screenshotPath: "screenshots/state.png",
          evidence: [],
          replayPath: [{ type: "goto", url: "http://localhost:3000" }]
        }
      ],
      assets: []
    };

    const html = generateStaticHtmlReport(run);

    expect(html).not.toContain("innerHTML");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<svg onload");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("\\u003cimg src=x");
    expect(html).not.toContain("panel graph");
    expect(html).not.toContain("node.style.left");
    expect(html).toContain("sectionFor(\"States\")");
    expect(html).toContain("sectionFor(\"Transitions\")");
    expect(html).toContain("sectionFor(\"Actions\")");
  });
});

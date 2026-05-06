import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeRunArtifacts } from "../crawler/crawl.js";
import type { CartographRun, DomSummary } from "../types.js";

function domSummary(): DomSummary {
  return {
    headings: ["Checkout"],
    visibleTextSample: ["Checkout"],
    roles: {},
    forms: [],
    buttons: [],
    links: [],
    inputs: [],
    dialogs: [],
    metrics: {
      elementCount: 1,
      visibleTextLength: 8,
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

function runFixture(outputDir: string): CartographRun {
  return {
    id: "artifact-test",
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
      outputDir,
      headed: false
    },
    summary: {
      id: "artifact-test",
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
    states: [
      {
        id: "s1",
        viewport: "desktop",
        url: "http://localhost:3000",
        title: "Checkout",
        label: "Checkout",
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
      }
    ],
    transitions: [],
    findings: [
      {
        id: "finding-1",
        severity: "warning",
        detector: "fixture",
        title: "Fixture finding",
        detail: "Fixture detail",
        stateId: "s1",
        screenshotPath: "screenshots/state.png",
        evidence: [],
        replayPath: [{ type: "goto", url: "http://localhost:3000" }]
      }
    ],
    assets: [{ id: "asset-s1", type: "screenshot", path: "screenshots/state.png", stateId: "s1" }]
  };
}

describe("run artifacts", () => {
  it("serializes replay assets into run data before writing report artifacts", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "cartograph-artifacts-"));
    try {
      await writeRunArtifacts(runFixture(outputDir));

      const runJson = JSON.parse(await readFile(path.join(outputDir, "run.json"), "utf8")) as CartographRun;
      const reportData = JSON.parse(await readFile(path.join(outputDir, "report-data.json"), "utf8")) as CartographRun;
      const replay = await readFile(path.join(outputDir, "replays/finding-1.spec.ts"), "utf8");

      expect(runJson.assets).toContainEqual({ id: "replay-finding-1", type: "replay", path: "replays/finding-1.spec.ts", findingId: "finding-1" });
      expect(reportData.assets).toEqual(runJson.assets);
      expect(replay).toContain("Fixture finding");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

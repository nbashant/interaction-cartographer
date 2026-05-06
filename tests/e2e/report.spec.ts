import { expect, test } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(process.cwd());
const fixtureDir = path.join(rootDir, "tests/.tmp/report-run");
let server: ChildProcessWithoutNullStreams;

test.beforeAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
  await mkdir(path.join(fixtureDir, "screenshots"), { recursive: true });
  await writeFile(path.join(fixtureDir, "screenshots/state.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"));
  const run = fixtureRun();
  await writeFile(path.join(fixtureDir, "run.json"), JSON.stringify(run, null, 2));
  await writeFile(path.join(fixtureDir, "report-data.json"), JSON.stringify(run, null, 2));
  await writeFile(path.join(fixtureDir, "report.md"), "# Fixture report\n");
  await writeFile(path.join(fixtureDir, "findings-report.md"), "# Fixture findings\n\n## Build Quality Scoreboard\n\nOverall: 68 / 100\n");
  await writeFile(path.join(fixtureDir, "findings-export.json"), JSON.stringify({ findings: run.findings, quality: run.quality }, null, 2));

  server = spawn("npm", ["run", "cartograph", "--", "view", fixtureDir, "--port", "4199", "--no-open"], {
    cwd: rootDir,
    env: process.env
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for report server")), 45_000);
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Glitchly report running at")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.stderr.on("data", (chunk) => {
      if (String(chunk).includes("Error")) {
        clearTimeout(timeout);
        reject(new Error(String(chunk)));
      }
    });
  });
});

test.afterAll(async () => {
  server?.kill();
  await rm(path.join(rootDir, "tests/.tmp"), { recursive: true, force: true });
});

test("report UI renders scanner, findings, screenshot evidence, details, and exports", async ({ page }) => {
  await page.goto("http://127.0.0.1:4199");
  await expect(page.getByText("Glitchly")).toBeVisible();
  await expect(page.getByLabel("Local app URL")).toBeVisible();
  await expect(page.getByLabel("Local app URL")).toHaveAttribute("placeholder", "http://localhost:3000");
  await expect(page.getByLabel("Local app URL")).toHaveValue("");
  await page.getByLabel("Local app URL").focus();
  await expect(page.getByLabel("Local app URL")).toBeFocused();
  const urlPlaceholderOpacity = await page
    .getByLabel("Local app URL")
    .evaluate((element) => window.getComputedStyle(element, "::placeholder").opacity);
  expect(urlPlaceholderOpacity).toBe("0");
  await expect(page.getByLabel("Actions")).toHaveAttribute("min", "1");
  await expect(page.getByLabel("Actions")).toHaveAttribute("max", "1000");
  await expect(page.getByLabel("Actions")).toHaveAttribute("placeholder", "1-1000");
  await expect(page.getByLabel("Actions")).toHaveValue("");
  const actionsInputAppearance = await page.getByLabel("Actions").evaluate((element) => window.getComputedStyle(element).appearance);
  expect(actionsInputAppearance).toBe("textfield");
  await expect(page.getByLabel("Depth")).toHaveAttribute("min", "0");
  await expect(page.getByLabel("Depth")).toHaveAttribute("max", "30");
  await expect(page.getByLabel("Depth")).toHaveAttribute("placeholder", "0-30");
  await expect(page.getByLabel("Depth")).toHaveValue("");
  await page.getByLabel("Actions").focus();
  await expect(page.getByLabel("Actions")).toBeFocused();
  await page.getByLabel("Actions").fill("100");
  await expect(page.getByLabel("Actions")).toHaveValue("100");
  await page.getByLabel("Depth").focus();
  await expect(page.getByLabel("Depth")).toBeFocused();
  await expect(page.getByLabel("Depth")).toHaveValue("");
  await page.getByRole("button", { name: "Scan limit guidance" }).hover();
  const limitsTooltip = page.locator("#scan-limit-tooltip-actions");
  await expect(limitsTooltip).toBeVisible();
  await expect(limitsTooltip).toContainText("Maximum UI interactions attempted per viewport.");
  await expect(limitsTooltip).toContainText("Maximum interaction chain length from the starting page.");
  await expect(limitsTooltip).toContainText("Recommended");
  await expect(limitsTooltip).toContainText("Actions 80");
  await expect(limitsTooltip).toContainText("Depth 6");
  await expect(page.getByRole("button", { name: "Scan real app" })).toBeVisible();
  await expect(page.locator(".summary-chip").filter({ hasText: "Findings" })).toBeVisible();
  await expect(page.locator(".summary-chip").filter({ hasText: "States" })).toBeVisible();
  await expect(page.locator(".screenshot-frame img")).toBeVisible();
  const screenshotLinkStyle = await page.getByRole("link", { name: "Open screenshot" }).evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      display: style.display,
      alignItems: style.alignItems,
      justifyContent: style.justifyContent,
      textAlign: style.textAlign
    };
  });
  expect(["inline-flex", "flex"]).toContain(screenshotLinkStyle.display);
  expect(screenshotLinkStyle).toMatchObject({
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center"
  });
  await page.getByRole("button", { name: /Promo service failed/ }).click();
  await expect(page.getByText("Replay path")).toBeVisible();
  await expect(page.getByText("POST /api/promo returned")).toBeVisible();
  const evidenceLayout = await page.evaluate(() => {
    const detail = document.querySelector(".finding-detail");
    const artifacts = document.querySelector(".artifact-explorer");
    const detailBox = detail?.getBoundingClientRect();
    const artifactBox = artifacts?.getBoundingClientRect();
    return {
      detailIsNotScrollable: detail ? detail.scrollHeight <= detail.clientHeight + 1 : false,
      artifactBelowEvidence: Boolean(detail && artifacts && detail.compareDocumentPosition(artifacts) & Node.DOCUMENT_POSITION_FOLLOWING),
      artifactTop: artifactBox?.top ?? 9999,
      detailBottom: detailBox?.bottom ?? 0
    };
  });
  expect(evidenceLayout.detailIsNotScrollable).toBe(true);
  expect(evidenceLayout.artifactBelowEvidence).toBe(true);
  expect(evidenceLayout.artifactTop).toBeGreaterThanOrEqual(evidenceLayout.detailBottom);
  const artifactHeight = await page.locator(".artifact-explorer").evaluate((element) => element.getBoundingClientRect().height);
  expect(artifactHeight).toBeGreaterThanOrEqual(620);

  const markdown = await page.request.get("http://127.0.0.1:4199/api/export/markdown");
  const json = await page.request.get("http://127.0.0.1:4199/api/export/json");
  const progress = await page.request.get("http://127.0.0.1:4199/api/scan/progress");
  expect(markdown.ok()).toBe(true);
  expect(json.ok()).toBe(true);
  expect(progress.ok()).toBe(true);
  expect((await progress.json()).phase).toBe("idle");
  expect(await markdown.text()).toContain("Build Quality Scoreboard");
  await page.getByRole("button", { name: "Build Quality" }).click();
  await expect(page.getByText("Build Quality Score")).toBeVisible();
  await expect(page.getByText("Needs polish")).toBeVisible();
  await expect(page.getByRole("button", { name: /Promo service failed/ })).toBeVisible();
  await page.getByRole("button", { name: /Promo service failed/ }).click();
  await expect(page.getByText("Replay path")).toBeVisible();
  await page.getByRole("button", { name: "Transitions" }).click();
  await expect(page.getByText("s1 -> s2")).toBeVisible();
});

test("report UI can stop an active scan and show partial results", async ({ page }) => {
  let stopCalled = false;
  let scanStarted = false;
  const stoppedRun = fixtureRun();
  stoppedRun.summary.status = "stopped";

  await page.route(/\/api\/run$/, (route) => route.fulfill({ json: null }));
  await page.route(/\/api\/scan$/, async (route) => {
    scanStarted = true;
    await page.waitForTimeout(500);
    await route.fulfill({ json: { run: stoppedRun, runDir: fixtureDir, stopped: true } });
  });
  await page.route(/\/api\/scan\/stop$/, (route) => {
    stopCalled = true;
    return route.fulfill({ json: { stopped: true } });
  });
  await page.route(/\/api\/scan\/progress$/, (route) =>
    route.fulfill({
      json: scanStarted ? {
        active: true,
        phase: "testing",
        message: "Clicking Apply promo",
        targetUrl: "http://localhost:3000",
        currentUrl: "http://localhost:3000/checkout",
        currentAction: "Apply promo",
        statesFound: 2,
        transitionsFound: 1,
        findingsFound: 1,
        actionsAttempted: 3,
        maxActions: 10,
        startedAt: "2026-05-05T00:00:00.000Z",
        updatedAt: "2026-05-05T00:00:01.000Z",
        recentEvents: [
          {
            id: "progress-1",
            timestamp: "2026-05-05T00:00:01.000Z",
            phase: "testing",
            message: "Clicking Apply promo",
            targetUrl: "http://localhost:3000",
            viewport: "desktop",
            currentUrl: "http://localhost:3000/checkout",
            currentAction: "Apply promo",
            statesFound: 2,
            transitionsFound: 1,
            findingsFound: 1,
            actionsAttempted: 3,
            maxActions: 10
          }
        ]
      } : idleProgress()
    })
  );

  await page.goto("http://127.0.0.1:4199");
  await page.getByRole("button", { name: "Scan real app" }).click();
  const activity = page.getByLabel("Live scan activity");
  await expect(activity).toBeVisible();
  await expect(activity.locator(".scan-activity-heading strong")).toHaveText("Testing actions");
  await expect(activity.locator(".activity-status strong")).toHaveText("Clicking Apply promo");
  await expect(activity.locator(".activity-counters div").filter({ hasText: "Actions" }).locator("strong")).toHaveText("3 / 10");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stopping" })).toBeVisible();
  await expect.poll(() => stopCalled).toBe(true);
  await expect(page.getByText("Stopped scan: partial results shown.")).toBeVisible();
});

test("reload attaches to an active scan and keeps stop controls visible", async ({ page }) => {
  let stopCalled = false;
  let active = true;
  const targetUrl = "http://127.0.0.1:5173/";
  const stoppedRun = fixtureRun();
  stoppedRun.startUrl = targetUrl;
  stoppedRun.summary.startUrl = targetUrl;
  stoppedRun.summary.status = "stopped";

  const activeProgress = {
    active: true,
    phase: "testing",
    message: "Clicking Checkout",
    targetUrl,
    currentUrl: `${targetUrl}checkout`,
    currentAction: "Checkout",
    statesFound: 3,
    transitionsFound: 2,
    findingsFound: 1,
    actionsAttempted: 4,
    maxActions: 10,
    startedAt: "2026-05-05T00:00:00.000Z",
    updatedAt: "2026-05-05T00:00:01.000Z",
    recentEvents: [
      {
        id: "progress-reload-1",
        timestamp: "2026-05-05T00:00:01.000Z",
        phase: "testing",
        message: "Clicking Checkout",
        targetUrl,
        currentUrl: `${targetUrl}checkout`,
        currentAction: "Checkout",
        statesFound: 3,
        transitionsFound: 2,
        findingsFound: 1,
        actionsAttempted: 4,
        maxActions: 10
      }
    ]
  };
  const stoppedProgress = {
    ...activeProgress,
    active: false,
    phase: "stopped",
    message: "Scan stopped; partial results are ready",
    updatedAt: "2026-05-05T00:00:02.000Z"
  };

  await page.route(/\/api\/run$/, (route) => route.fulfill({ json: active ? null : stoppedRun }));
  await page.route(/\/api\/scan\/progress$/, (route) => route.fulfill({ json: active ? activeProgress : stoppedProgress }));
  await page.route(/\/api\/scan\/stop$/, (route) => {
    stopCalled = true;
    active = false;
    return route.fulfill({ json: { stopped: true, targetUrl, startedAt: activeProgress.startedAt } });
  });

  await page.goto("http://127.0.0.1:4199");
  await expect(page.getByLabel("Local app URL")).toHaveValue(targetUrl);
  await expect(page.getByRole("button", { name: "Scanning" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  await page.reload();

  const activity = page.getByLabel("Live scan activity");
  await expect(activity).toBeVisible();
  await expect(activity.locator(".scan-activity-heading strong")).toHaveText("Testing actions");
  await expect(activity.locator(".activity-status strong")).toHaveText("Clicking Checkout");
  await expect(page.getByLabel("Local app URL")).toHaveValue(targetUrl);
  await expect(page.getByRole("button", { name: "Scanning" })).toBeDisabled();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => stopCalled).toBe(true);
  await expect(page.getByText("Stopped scan: partial results shown.")).toBeVisible();
});

test("scan option preferences survive reloads", async ({ page }) => {
  await page.goto("http://127.0.0.1:4199");
  await page.getByLabel("Viewports").selectOption("mobile");
  await page.getByLabel("Allow local submits").setChecked(false);
  await page.getByLabel("Allow external links").setChecked(true);

  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(window.localStorage.getItem("glitchly.scanPreferences.v1") ?? "{}") as {
          viewports?: string;
          allowSubmit?: boolean;
          allowExternal?: boolean;
        }
      )
    )
    .toEqual({ viewports: "mobile", allowSubmit: false, allowExternal: true });

  await page.reload();

  await expect(page.getByLabel("Viewports")).toHaveValue("mobile");
  await expect(page.getByLabel("Allow local submits")).not.toBeChecked();
  await expect(page.getByLabel("Allow external links")).toBeChecked();

  const secondPage = await page.context().newPage();
  await secondPage.goto("http://127.0.0.1:4199");
  await expect(secondPage.getByLabel("Viewports")).toHaveValue("mobile");
  await expect(secondPage.getByLabel("Allow local submits")).not.toBeChecked();
  await expect(secondPage.getByLabel("Allow external links")).toBeChecked();
  await secondPage.close();
});

test("target URL starts as a placeholder and persists after a successful scan", async ({ page }) => {
  const scannedRun = fixtureRun();
  scannedRun.startUrl = "http://127.0.0.1:5173/";
  scannedRun.summary.startUrl = "http://127.0.0.1:5173/";

  await page.route(/\/api\/run$/, (route) => route.fulfill({ json: null }));
  await page.route(/\/api\/scan$/, (route) => route.fulfill({ json: { run: scannedRun, runDir: fixtureDir, stopped: false } }));

  await page.goto("http://127.0.0.1:4199");
  const urlInput = page.getByLabel("Local app URL");
  await expect(urlInput).toHaveValue("");
  await expect(urlInput).toHaveAttribute("placeholder", "http://localhost:3000");

  await urlInput.fill("http://127.0.0.1:5173/");
  await page.getByRole("button", { name: "Scan real app" }).click();
  await expect(page.getByRole("banner").getByText("http://127.0.0.1:5173/", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("glitchly.targetUrl.v1")))
    .toBe("http://127.0.0.1:5173/");

  await page.reload();

  await expect(page.getByLabel("Local app URL")).toHaveValue("http://127.0.0.1:5173/");
});

test("artifact explorer stays directly below the evidence area on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1152 });
  const noFindingsRun = fixtureRun();
  noFindingsRun.findings = [];
  noFindingsRun.summary.findingCount = 0;
  noFindingsRun.summary.issuesBySeverity = { info: 0, warning: 0, critical: 0 };
  noFindingsRun.quality.topRisks = [];

  await page.route(/\/api\/run$/, (route) => route.fulfill({ json: noFindingsRun }));
  await page.goto("http://127.0.0.1:4199");

  await expect(page.getByRole("button", { name: "Transitions" })).toBeVisible();
  const layoutBefore = await page.evaluate(() => {
    const artifacts = document.querySelector(".artifact-explorer");
    const detail = document.querySelector(".finding-detail");
    const artifactBox = artifacts?.getBoundingClientRect();
    const detailBox = detail?.getBoundingClientRect();
    return {
      artifactsComeAfterEvidence: Boolean(detail && artifacts && detail.compareDocumentPosition(artifacts) & Node.DOCUMENT_POSITION_FOLLOWING),
      artifactTop: artifactBox?.top ?? 9999,
      detailBottom: detailBox?.bottom ?? 0
    };
  });
  expect(layoutBefore.artifactsComeAfterEvidence).toBe(true);
  expect(layoutBefore.artifactTop).toBeLessThan(360);
  expect(layoutBefore.artifactTop).toBeGreaterThanOrEqual(layoutBefore.detailBottom);

  await page.getByRole("button", { name: "Transitions" }).click();
  const artifactTopAfter = await page.locator(".artifact-explorer").evaluate((element) => element.getBoundingClientRect().top);
  expect(Math.abs(artifactTopAfter - layoutBefore.artifactTop)).toBeLessThan(2);
});

test("build quality metadata risks do not leave stale finding evidence selected", async ({ page }) => {
  const metadataRiskRun = fixtureRun();
  metadataRiskRun.quality.topRisks.unshift({
    id: "risk-state-budget",
    title: "State budget was exhausted",
    severity: "warning",
    categoryId: "state_coverage",
    findingIds: [],
    stateIds: ["s1"],
    replayPath: [{ type: "goto", url: "http://localhost:3000" }]
  });

  await page.route(/\/api\/run$/, (route) => route.fulfill({ json: metadataRiskRun }));
  await page.goto("http://127.0.0.1:4199");
  await page.getByRole("button", { name: "Build Quality" }).click();
  await page.getByRole("button", { name: /State budget was exhausted/ }).click();

  await expect(page.getByText("Select a finding to inspect screenshot evidence")).toBeVisible();
  await expect(page.locator(".artifact-tabs button.is-selected")).toHaveText("States");
});

function idleProgress() {
  return {
    active: false,
    phase: "idle",
    message: "No scan is running.",
    statesFound: 0,
    transitionsFound: 0,
    findingsFound: 0,
    actionsAttempted: 0,
    maxActions: 0,
    recentEvents: []
  };
}

function fixtureRun() {
  return {
    id: "fixture",
    startUrl: "http://localhost:3000",
    createdAt: "2026-05-05T00:00:00.000Z",
    options: {
      maxActions: 10,
      maxDepth: 3,
      maxDurationMs: 10000,
      viewports: [
        { name: "desktop", width: 1440, height: 900 },
        { name: "mobile", width: 390, height: 844 }
      ],
      allowExternal: false,
      allowSubmit: true,
      sameOriginOnly: true,
      denyActionLabels: [],
      allowActionLabels: [],
      outputDir: fixtureDir,
      headed: false
    },
    summary: {
      id: "fixture",
      startUrl: "http://localhost:3000",
      createdAt: "2026-05-05T00:00:00.000Z",
      status: "completed",
      durationMs: 1200,
      stateCount: 2,
      transitionCount: 1,
      findingCount: 1,
      actionsAttempted: 1,
      viewports: ["desktop", "mobile"],
      issuesBySeverity: { info: 0, warning: 0, critical: 1 }
    },
    quality: {
      overallScore: 68,
      status: "needs_polish",
      generatedAt: "2026-05-05T00:00:00.000Z",
      formula: {
        weights: {
          interaction_health: 0.25,
          responsive_health: 0.2,
          error_health: 0.2,
          accessibility_smoke: 0.15,
          state_coverage: 0.1,
          visual_stability: 0.1
        },
        severityPenalty: { critical: 18, warning: 8, info: 3 },
        repeatedFindingPenaltyMultiplier: 0.35,
        description:
          "overall = interaction_health * 0.25 + responsive_health * 0.20 + error_health * 0.20 + accessibility_smoke * 0.15 + state_coverage * 0.10 + visual_stability * 0.10"
      },
      categories: [
        {
          id: "interaction_health",
          label: "Interaction Health",
          score: 82,
          weight: 0.25,
          summary: "Most crawled interactions changed state.",
          evidenceFindingIds: [],
          evidenceStateIds: ["s1"]
        },
        {
          id: "responsive_health",
          label: "Responsive Health",
          score: 72,
          weight: 0.2,
          summary: "Mobile state was crawled with one layout risk.",
          evidenceFindingIds: [],
          evidenceStateIds: ["s2"]
        },
        {
          id: "error_health",
          label: "Error Health",
          score: 58,
          weight: 0.2,
          summary: "A failed request was recorded during interaction.",
          evidenceFindingIds: ["network-error-s2"],
          evidenceStateIds: ["s2"]
        },
        {
          id: "accessibility_smoke",
          label: "Accessibility Smoke",
          score: 90,
          weight: 0.15,
          summary: "No basic accessibility smoke issues were recorded.",
          evidenceFindingIds: [],
          evidenceStateIds: []
        },
        {
          id: "state_coverage",
          label: "State Coverage",
          score: 74,
          weight: 0.1,
          summary: "Crawl reached fixture states within budget. This is not code coverage.",
          evidenceFindingIds: [],
          evidenceStateIds: ["s1", "s2"]
        },
        {
          id: "visual_stability",
          label: "Visual Stability",
          score: 80,
          weight: 0.1,
          summary: "Screenshots were structurally stable in the fixture.",
          evidenceFindingIds: [],
          evidenceStateIds: ["s1", "s2"]
        }
      ],
      topRisks: [
        {
          id: "risk-network-error",
          title: "Promo service failed",
          severity: "critical",
          categoryId: "error_health",
          findingIds: ["network-error-s2"],
          stateIds: ["s2"],
          replayPath: [
            { type: "goto", url: "http://localhost:3000" },
            { type: "click", selector: "[data-cartograph='apply-promo']", label: "Apply promo" }
          ]
        }
      ],
      strengths: [
        {
          id: "strength-accessibility",
          title: "Accessibility Smoke held up",
          detail: "No basic accessibility smoke issues were recorded.",
          categoryId: "accessibility_smoke"
        }
      ]
    },
    states: [
      state("s1", "desktop", "Checkout form"),
      state("s2", "mobile", "Mobile checkout")
    ],
    transitions: [
      {
        id: "t1",
        fromStateId: "s1",
        toStateId: "s2",
        actionId: "a1",
        action: {
          id: "a1",
          stateId: "s1",
          type: "click",
          selector: "[data-cartograph='apply-promo']",
          role: "button",
          label: "Apply promo",
          risk: "safe",
          reason: "fixture",
          score: 10
        },
        durationMs: 100,
        status: "changed",
        screenshotBeforePath: "screenshots/state.png",
        screenshotAfterPath: "screenshots/state.png"
      }
    ],
    findings: [
      {
        id: "network-error-s2",
        severity: "critical",
        detector: "network-error",
        title: "Promo service failed",
        detail: "POST /api/promo returned 500",
        stateId: "s2",
        transitionId: "t1",
        actionId: "a1",
        selector: "[data-cartograph='apply-promo']",
        screenshotPath: "screenshots/state.png",
        evidence: [{ label: "Status", value: "POST /api/promo 500" }],
        replayPath: [
          { type: "goto", url: "http://localhost:3000" },
          { type: "click", selector: "[data-cartograph='apply-promo']", label: "Apply promo" }
        ]
      }
    ],
    assets: [{ id: "asset-s1", type: "screenshot", path: "screenshots/state.png", stateId: "s1" }]
  };
}

function state(id: string, viewport: "desktop" | "mobile", label: string) {
  return {
    id,
    viewport,
    url: "http://localhost:3000",
    title: label,
    label,
    fingerprint: {
      urlKey: "http://localhost:3000/",
      textHash: id,
      domHash: id,
      roleHash: id,
      visualHash: id,
      viewportKey: viewport
    },
    screenshotPath: "screenshots/state.png",
    domSummary: {
      headings: [label],
      visibleTextSample: [label],
      roles: { button: 1 },
      forms: [],
      buttons: [],
      links: [],
      inputs: [],
      dialogs: [],
      metrics: {
        elementCount: 10,
        visibleTextLength: 60,
        scrollWidth: 1440,
        clientWidth: 1440,
        overflowX: 0,
        duplicateIdCount: 0,
        unnamedButtonCount: 0,
        unlabeledInputCount: 0,
        offscreenInteractiveCount: 0,
        textOverflowCount: 0,
        mainBlank: false,
        disabledSubmitLikeCount: 0
      }
    },
    interactiveCount: 1,
    consoleErrors: [],
    networkErrors: [],
    replayPath: [{ type: "goto", url: "http://localhost:3000" }]
  };
}

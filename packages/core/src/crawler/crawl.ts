import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { actionPriority, actionToReplayStep, classifyActionRisk, isLocalUrl } from "../actions/risk.js";
import { runDetectors } from "../detectors/index.js";
import { generateBuildQualityScoreboard } from "../quality/scoreboard.js";
import { generateStaticHtmlReport } from "../report/html.js";
import { generateFindingsJson, generateFindingsMarkdown, generateMarkdownReport } from "../report/markdown.js";
import { areSimilarFingerprints, createFingerprint, hashString } from "../state/fingerprint.js";
import type {
  ActionQueueItem,
  CandidateAction,
  CartographRun,
  ConsoleEvent,
  CrawlOptions,
  DEFAULT_VIEWPORTS as DefaultViewportsType,
  DomSummary,
  NetworkEvent,
  ReplayStep,
  RunSummary,
  ScanProgressEvent,
  ScanProgressPhase,
  ScanProgressReporter,
  UIState,
  UITransition,
  ViewportConfig
} from "../types.js";
import { DEFAULT_VIEWPORTS } from "../types.js";

type InstrumentedPage = {
  page: Page;
  consoleEvents: ConsoleEvent[];
  networkEvents: NetworkEvent[];
};

type RegisterResult = {
  state: UIState;
  isNew: boolean;
};

type ExecuteResult = {
  status: UITransition["status"];
  replayStep?: ReplayStep;
  error?: string;
  durationMs: number;
};

type CartographRuntimeOptions = Partial<CrawlOptions> & {
  signal?: AbortSignal;
  onProgress?: ScanProgressReporter;
};

const defaultOptions = {
  maxActions: 80,
  maxDepth: 6,
  maxDurationMs: 90_000,
  allowExternal: false,
  allowSubmit: false,
  sameOriginOnly: true,
  denyActionLabels: [],
  allowActionLabels: [],
  headed: false
};

export function normalizeCrawlOptions(startUrl: string, partial: CartographRuntimeOptions = {}): CrawlOptions {
  const { signal: _signal, onProgress: _onProgress, ...crawlPartial } = partial;
  const viewports = crawlPartial.viewports?.length ? crawlPartial.viewports : DEFAULT_VIEWPORTS;
  const outputDir = crawlPartial.outputDir ?? path.resolve(process.cwd(), ".glitchly", "runs", slugRunId(startUrl));
  return {
    ...defaultOptions,
    ...crawlPartial,
    viewports,
    outputDir
  };
}

export async function cartograph(startUrl: string, partialOptions: CartographRuntimeOptions = {}): Promise<CartographRun> {
  const signal = partialOptions.signal;
  const reportProgress = partialOptions.onProgress;
  const options = normalizeCrawlOptions(startUrl, partialOptions);
  const createdAt = new Date().toISOString();
  const runId = path.basename(options.outputDir) || slugRunId(startUrl);
  const started = Date.now();
  const run: CartographRun = {
    id: runId,
    startUrl,
    createdAt,
    options,
    summary: emptySummary(runId, startUrl, createdAt, options.viewports),
    states: [],
    transitions: [],
    findings: [],
    assets: []
  };

  await mkdir(path.join(options.outputDir, "screenshots"), { recursive: true });
  await mkdir(path.join(options.outputDir, "replays"), { recursive: true });

  let actionsAttempted = 0;
  emitProgress(reportProgress, run, options, {
    phase: "starting",
    message: `Preparing scan for ${startUrl}`,
    actionsAttempted
  });
  for (const viewport of options.viewports) {
    if (signal?.aborted) break;
    if (Date.now() - started > options.maxDurationMs) break;
    emitProgress(reportProgress, run, options, {
      phase: "opening",
      message: `Opening ${viewport.name} viewport`,
      viewport: viewport.name,
      currentUrl: startUrl,
      actionsAttempted
    });
    const browser = await chromium.launch({ headless: !options.headed });
    try {
      actionsAttempted += await crawlViewport(browser, run, startUrl, viewport, options, started, actionsAttempted, reportProgress, signal);
    } finally {
      await browser.close();
    }
  }

  run.summary = summarizeRun(run, actionsAttempted, Date.now() - started, signal?.aborted ? "stopped" : "completed");
  run.quality = generateBuildQualityScoreboard(run);
  emitProgress(reportProgress, run, options, {
    phase: "writing",
    message: "Writing screenshots, findings, exports, and replay artifacts",
    actionsAttempted
  });
  await writeRunArtifacts(run);
  emitProgress(reportProgress, run, options, {
    phase: run.summary.status === "stopped" ? "stopped" : "completed",
    message: run.summary.status === "stopped" ? "Scan stopped; partial results are ready" : "Scan complete; findings are ready",
    actionsAttempted
  });
  return run;
}

export async function loadRun(runDir: string): Promise<CartographRun> {
  const data = await readFile(path.join(runDir, "run.json"), "utf8");
  return JSON.parse(data) as CartographRun;
}

async function crawlViewport(
  browser: Browser,
  run: CartographRun,
  startUrl: string,
  viewport: ViewportConfig,
  options: CrawlOptions,
  started: number,
  baseActionsAttempted: number,
  reportProgress?: ScanProgressReporter,
  signal?: AbortSignal
): Promise<number> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    reducedMotion: "reduce",
    colorScheme: "light"
  });
  await context.addInitScript(() => {
    const install = () => {
      const style = document.createElement("style");
      style.textContent = "*,*::before,*::after{animation-duration:0.001s!important;transition-duration:0.001s!important;scroll-behavior:auto!important}";
      document.documentElement.appendChild(style);
    };
    if (document.documentElement) install();
    else document.addEventListener("DOMContentLoaded", install, { once: true });
  });
  const page = await context.newPage();
  const closeOnAbort = () => {
    void context.close().catch(() => undefined);
  };
  signal?.addEventListener("abort", closeOnAbort, { once: true });
  const instrumented = instrumentPage(page);
  const queue: ActionQueueItem[] = [];
  const seenActionKeys = new Set<string>();
  let actionsAttempted = 0;

  try {
    if (signal?.aborted) return actionsAttempted;
    emitProgress(reportProgress, run, options, {
      phase: "opening",
      message: `Loading ${startUrl}`,
      viewport: viewport.name,
      currentUrl: startUrl,
      actionsAttempted: baseActionsAttempted + actionsAttempted
    });
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await settlePage(page);

    const initial = await captureState(instrumented, run, viewport, {
      replayPath: [{ type: "goto", url: startUrl }],
      consoleStart: 0,
      networkStart: 0
    });
    const initialRegistration = registerState(run, initial);
    emitProgress(reportProgress, run, options, {
      phase: "capturing",
      message: `Captured ${viewport.name} state: ${initialRegistration.state.label}`,
      viewport: viewport.name,
      currentUrl: initialRegistration.state.url,
      actionsAttempted: baseActionsAttempted + actionsAttempted
    });
    const initialActions = await extractActions(page, initialRegistration.state.id, startUrl, options);
    enqueueActions(queue, initialActions, initialRegistration.state.id, initialRegistration.state.replayPath, 0);

    while (queue.length > 0 && actionsAttempted < options.maxActions && Date.now() - started < options.maxDurationMs && !signal?.aborted) {
      queue.sort((a, b) => b.action.score - a.action.score);
      const item = queue.shift();
      if (!item) break;
      if (item.depth > options.maxDepth) continue;

      const actionKey = `${viewport.name}:${item.fromStateId}:${item.action.type}:${item.action.selector}:${item.action.label ?? ""}`;
      if (seenActionKeys.has(actionKey)) continue;
      seenActionKeys.add(actionKey);

      if (!isActionAllowed(item.action, startUrl, options)) continue;

      await restoreReplayPath(page, item.replayPath, signal);
      if (signal?.aborted) break;
      await settlePage(page);
      const beforeState = run.states.find((state) => state.id === item.fromStateId);
      if (!beforeState) continue;

      const consoleStart = instrumented.consoleEvents.length;
      const networkStart = instrumented.networkEvents.length;
      emitProgress(reportProgress, run, options, {
        phase: "testing",
        message: `${actionVerb(item.action)} ${item.action.label ?? item.action.selector}`,
        viewport: viewport.name,
        currentUrl: page.url(),
        currentAction: item.action.label ?? item.action.selector,
        actionsAttempted: baseActionsAttempted + actionsAttempted
      });
      const result = await executeAction(page, item.action);
      actionsAttempted += 1;
      if (signal?.aborted) break;
      await settlePage(page);

      const afterCapture = await captureState(instrumented, run, viewport, {
        replayPath: result.replayStep ? [...item.replayPath, result.replayStep] : item.replayPath,
        firstSeenAtActionId: item.action.id,
        consoleStart,
        networkStart
      });
      const afterRegistration = registerState(run, afterCapture);
      const afterStateForEvidence = {
        ...afterCapture,
        id: afterRegistration.state.id,
        replayPath: result.replayStep ? [...item.replayPath, result.replayStep] : afterRegistration.state.replayPath
      };
      const changed = !areSimilarFingerprints(beforeState.fingerprint, afterCapture.fingerprint);
      const transition: UITransition = {
        id: `t${run.transitions.length + 1}`,
        fromStateId: beforeState.id,
        toStateId: afterRegistration.state.id,
        actionId: item.action.id,
        action: item.action,
        durationMs: result.durationMs,
        status: result.status === "error" ? "error" : changed || beforeState.id !== afterRegistration.state.id ? "changed" : "no_effect",
        screenshotBeforePath: beforeState.screenshotPath,
        screenshotAfterPath: afterCapture.screenshotPath
      };
      run.transitions.push(transition);

      const findings = await runDetectors({
        before: beforeState,
        after: afterStateForEvidence,
        transition,
        options
      });
      const newFindings = dedupeAgainstRun(run.findings, findings);
      run.findings.push(...newFindings);
      emitProgress(reportProgress, run, options, {
        phase: newFindings.length ? "capturing" : "testing",
        message: newFindings.length
          ? `Found ${newFindings.length} issue(s) after ${item.action.label ?? item.action.selector}`
          : `${actionVerb(item.action)} ${item.action.label ?? item.action.selector} finished as ${transition.status}`,
        viewport: viewport.name,
        currentUrl: afterRegistration.state.url,
        currentAction: item.action.label ?? item.action.selector,
        actionsAttempted: baseActionsAttempted + actionsAttempted
      });

      if (afterRegistration.isNew && transition.status !== "blocked") {
        const nextActions = await extractActions(page, afterRegistration.state.id, startUrl, options);
        enqueueActions(queue, nextActions, afterRegistration.state.id, afterRegistration.state.replayPath, item.depth + 1);
      }
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    signal?.removeEventListener("abort", closeOnAbort);
    await context.close().catch(() => undefined);
  }
  return actionsAttempted;
}

function emitProgress(
  reportProgress: ScanProgressReporter | undefined,
  run: CartographRun,
  options: CrawlOptions,
  input: {
    phase: ScanProgressPhase;
    message: string;
    actionsAttempted: number;
    viewport?: ViewportConfig["name"];
    currentUrl?: string;
    currentAction?: string;
  }
): void {
  if (!reportProgress) return;
  const timestamp = new Date().toISOString();
  const event: ScanProgressEvent = {
    id: `progress-${timestamp}-${run.states.length}-${run.transitions.length}-${run.findings.length}`,
    timestamp,
    phase: input.phase,
    message: input.message,
    targetUrl: run.startUrl,
    viewport: input.viewport,
    currentUrl: input.currentUrl,
    currentAction: input.currentAction,
    statesFound: run.states.length,
    transitionsFound: run.transitions.length,
    findingsFound: run.findings.length,
    actionsAttempted: input.actionsAttempted,
    maxActions: options.maxActions
  };
  reportProgress(event);
}

function actionVerb(action: CandidateAction): string {
  if (action.type === "fill") return "Filling";
  if (action.type === "select") return "Selecting";
  if (action.type === "press") return "Pressing";
  if (action.type === "hover") return "Hovering";
  return "Clicking";
}

function instrumentPage(page: Page): InstrumentedPage {
  const consoleEvents: ConsoleEvent[] = [];
  const networkEvents: NetworkEvent[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
      consoleEvents.push({
        type: message.type(),
        text: message.text(),
        location: location.url ? `${location.url}:${location.lineNumber}:${location.columnNumber}` : undefined,
        timestamp: new Date().toISOString()
      });
    }
  });

  page.on("requestfailed", (request) => {
    networkEvents.push({
      method: request.method(),
      url: request.url(),
      failureText: request.failure()?.errorText ?? "request failed",
      timestamp: new Date().toISOString()
    });
  });

  page.on("response", (response) => {
    const status = response.status();
    if (status >= 400) {
      networkEvents.push({
        method: response.request().method(),
        url: response.url(),
        status,
        timestamp: new Date().toISOString()
      });
    }
  });

  return { page, consoleEvents, networkEvents };
}

async function captureState(
  instrumented: InstrumentedPage,
  run: CartographRun,
  viewport: ViewportConfig,
  input: {
    replayPath: ReplayStep[];
    firstSeenAtActionId?: string;
    consoleStart: number;
    networkStart: number;
  }
): Promise<UIState> {
  const { page } = instrumented;
  const index = run.states.length + run.transitions.length + 1;
  const url = page.url();
  const title = await page.title().catch(() => "");
  const summary = await summarizeDom(page);
  const label = labelState(summary, url, title);
  const screenshotPath = `screenshots/${viewport.name}-${String(index).padStart(3, "0")}-${slug(label)}.png`;
  const screenshotAbs = path.join(run.options.outputDir, screenshotPath);
  await page.screenshot({ path: screenshotAbs, fullPage: false, animations: "disabled" });
  const screenshotHash = hashString(await readFile(screenshotAbs, "base64"));
  const fingerprint = createFingerprint({
    url,
    viewport: viewport.name,
    summary,
    screenshotHash
  });

  return {
    id: `s${run.states.length + 1}`,
    viewport: viewport.name,
    url,
    title,
    label,
    fingerprint,
    screenshotPath,
    domSummary: summary,
    interactiveCount: summary.buttons.length + summary.links.length + summary.inputs.length,
    consoleErrors: instrumented.consoleEvents.slice(input.consoleStart),
    networkErrors: instrumented.networkEvents.slice(input.networkStart),
    firstSeenAtActionId: input.firstSeenAtActionId,
    replayPath: input.replayPath
  };
}

async function summarizeDom(page: Page): Promise<DomSummary> {
  return page.evaluate(() => {
    const escapeCss = (value: string) => {
      const css = (window as typeof window & { CSS?: { escape?: (value: string) => string } }).CSS;
      return css?.escape ? css.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    };

    const text = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const isElementVisible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
    };
    const selectorFor = (element: Element): string => {
      const htmlElement = element as HTMLElement;
      if (htmlElement.dataset.cartograph) return `[data-cartograph="${escapeCss(htmlElement.dataset.cartograph)}"]`;
      if (htmlElement.dataset.testid) return `[data-testid="${escapeCss(htmlElement.dataset.testid)}"]`;
      if (element.id) return `#${escapeCss(element.id)}`;
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body && parts.length < 5) {
        const tag = current.tagName.toLowerCase();
        const siblings = Array.from(current.parentElement?.children ?? []).filter((sibling) => sibling.tagName === current?.tagName);
        const nth = siblings.indexOf(current) + 1;
        parts.unshift(`${tag}:nth-of-type(${Math.max(nth, 1)})`);
        current = current.parentElement;
      }
      return `body > ${parts.join(" > ")}`;
    };
    const accessibleName = (element: Element): string => {
      const html = element as HTMLElement;
      const labelledBy = element.getAttribute("aria-labelledby");
      const byId = labelledBy
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText)
        .filter(Boolean)
        .join(" ");
      const ownText = text(html.innerText || html.textContent);
      const label =
        element.getAttribute("aria-label") ||
        byId ||
        ownText ||
        element.getAttribute("title") ||
        element.getAttribute("name") ||
        element.getAttribute("placeholder") ||
        (html instanceof HTMLInputElement ? html.value : "");
      return text(label).slice(0, 96);
    };
    const roleFor = (element: Element): string | undefined => {
      const explicit = element.getAttribute("role");
      if (explicit) return explicit;
      const tag = element.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a") return "link";
      if (tag === "input" || tag === "textarea" || tag === "select") return "textbox";
      if (tag.match(/^h[1-6]$/)) return "heading";
      if (tag === "dialog") return "dialog";
      return undefined;
    };
    const boxFor = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const summarize = (element: Element) => ({
      selector: selectorFor(element),
      label: accessibleName(element),
      role: roleFor(element),
      tagName: element.tagName.toLowerCase(),
      box: boxFor(element),
      disabled: (element as HTMLButtonElement | HTMLInputElement).disabled || element.getAttribute("aria-disabled") === "true"
    });

    const visibleElements = Array.from(document.body.querySelectorAll<HTMLElement>("*")).filter(isElementVisible);
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,[role='heading']"))
      .filter(isElementVisible)
      .map((element) => text((element as HTMLElement).innerText))
      .filter(Boolean)
      .slice(0, 8);
    const visibleTextSample = visibleElements
      .map((element) => text(element.innerText))
      .filter((value) => value.length > 1 && value.length < 220)
      .slice(0, 40);
    const roleEntries = visibleElements.map(roleFor).filter(Boolean) as string[];
    const roles = roleEntries.reduce<Record<string, number>>((acc, role) => {
      acc[role] = (acc[role] ?? 0) + 1;
      return acc;
    }, {});
    const forms = Array.from(document.querySelectorAll("form")).filter(isElementVisible).map((form) => ({
      selector: selectorFor(form),
      label: accessibleName(form) || headings[0] || "form",
      inputCount: form.querySelectorAll("input,textarea,select").length,
      submitCount: form.querySelectorAll("button,input[type='submit']").length
    }));
    const buttons = Array.from(document.querySelectorAll("button,[role='button'],input[type='button'],input[type='submit']"))
      .filter(isElementVisible)
      .map(summarize);
    const links = Array.from(document.querySelectorAll("a,[role='link'],[role='tab'],[role='menuitem']"))
      .filter(isElementVisible)
      .map(summarize);
    const inputs = Array.from(document.querySelectorAll("input:not([type='hidden']),textarea,select"))
      .filter(isElementVisible)
      .map(summarize);
    const dialogs = Array.from(document.querySelectorAll("dialog,[role='dialog'],[aria-modal='true'],.modal,.drawer"))
      .filter(isElementVisible)
      .map(summarize);
    const ids = Array.from(document.querySelectorAll("[id]")).map((element) => element.id).filter(Boolean);
    const duplicateIdCount = ids.length - new Set(ids).size;
    const unnamedButtonCount = buttons.filter((button) => !button.label && !button.disabled).length;
    const unlabeledInputCount = inputs.filter((input) => !input.label && !input.disabled).length;
    const interactive = [...buttons, ...links, ...inputs].filter((item) => !item.disabled);
    const offscreenInteractiveCount = interactive.filter((item) => {
      const box = item.box;
      return Boolean(box && (box.x < -4 || box.y < -4 || box.x + box.width > window.innerWidth + 4 || box.y + box.height > window.innerHeight + 4));
    }).length;
    const textOverflowCount = visibleElements
      .filter((element) => {
        const hasText = text(element.innerText).length > 8;
        const style = window.getComputedStyle(element);
        return hasText && style.overflow !== "hidden" && (element.scrollWidth > element.clientWidth + 8 || element.scrollHeight > element.clientHeight + 8);
      })
      .slice(0, 12).length;
    const main = document.querySelector<HTMLElement>("[data-cartograph-main],main,[role='main']");
    const mainRect = main?.getBoundingClientRect();
    const mainText = text(main?.innerText);
    const mainBlank = Boolean(
      main &&
        mainRect &&
        mainRect.width * mainRect.height > window.innerWidth * window.innerHeight * 0.24 &&
        (mainText.length < 16 || main.dataset.cartographBlank === "true")
    );
    const disabledSubmitLikeCount = buttons.filter((button) => {
      const label = button.label.toLowerCase();
      return Boolean(button.disabled && label.match(/continue|submit|save|apply|place order|checkout|confirm/));
    }).length;

    return {
      headings,
      visibleTextSample,
      roles,
      forms,
      buttons,
      links,
      inputs,
      dialogs,
      metrics: {
        elementCount: visibleElements.length,
        visibleTextLength: text(document.body.innerText).length,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        duplicateIdCount,
        unnamedButtonCount,
        unlabeledInputCount,
        offscreenInteractiveCount,
        textOverflowCount,
        mainBlank,
        disabledSubmitLikeCount
      }
    };
  });
}

async function extractActions(page: Page, stateId: string, startUrl: string, options: CrawlOptions): Promise<CandidateAction[]> {
  const rawActions = await page.evaluate(() => {
    const escapeCss = (value: string) => {
      const css = (window as typeof window & { CSS?: { escape?: (value: string) => string } }).CSS;
      return css?.escape ? css.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    };
    const text = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const isVisible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
    };
    const selectorFor = (element: Element): string => {
      const htmlElement = element as HTMLElement;
      if (htmlElement.dataset.cartograph) return `[data-cartograph="${escapeCss(htmlElement.dataset.cartograph)}"]`;
      if (htmlElement.dataset.testid) return `[data-testid="${escapeCss(htmlElement.dataset.testid)}"]`;
      if (element.id) return `#${escapeCss(element.id)}`;
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body && parts.length < 5) {
        const tag = current.tagName.toLowerCase();
        const siblings = Array.from(current.parentElement?.children ?? []).filter((sibling) => sibling.tagName === current?.tagName);
        const nth = siblings.indexOf(current) + 1;
        parts.unshift(`${tag}:nth-of-type(${Math.max(nth, 1)})`);
        current = current.parentElement;
      }
      return `body > ${parts.join(" > ")}`;
    };
    const accessibleName = (element: Element): string => {
      const html = element as HTMLElement;
      const labelledBy = element.getAttribute("aria-labelledby");
      const byId = labelledBy
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText)
        .filter(Boolean)
        .join(" ");
      const ownText = text(html.innerText || html.textContent);
      return text(
        element.getAttribute("aria-label") ||
          byId ||
          ownText ||
          element.getAttribute("title") ||
          element.getAttribute("name") ||
          element.getAttribute("placeholder") ||
          (html instanceof HTMLInputElement ? html.value : "")
      ).slice(0, 96);
    };
    const roleFor = (element: Element): string | undefined => {
      const explicit = element.getAttribute("role");
      if (explicit) return explicit;
      const tag = element.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a") return "link";
      if (tag === "select") return "combobox";
      if (tag === "textarea" || tag === "input") return "textbox";
      return undefined;
    };
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        "button,a,input:not([type='hidden']),select,textarea,[role='button'],[role='link'],[role='tab'],[role='menuitem'],[tabindex],[data-cartograph-action]"
      )
    )
      .filter(isVisible)
      .filter((element) => !(element as HTMLButtonElement | HTMLInputElement).disabled && element.getAttribute("aria-disabled") !== "true")
      .filter((element) => element.getAttribute("aria-selected") !== "true" && !element.classList.contains("active"))
      .map((element) => {
        const tag = element.tagName.toLowerCase();
        const inputType = element instanceof HTMLInputElement ? element.type : "";
        const role = roleFor(element);
        const rect = element.getBoundingClientRect();
        const href = element instanceof HTMLAnchorElement ? element.href : undefined;
        const type =
          tag === "select"
            ? "select"
            : tag === "textarea" || (tag === "input" && !["button", "submit", "checkbox", "radio"].includes(inputType))
              ? "fill"
              : "click";
        return {
          type,
          selector: selectorFor(element),
          role,
          label: accessibleName(element),
          text: text(element.innerText || element.textContent).slice(0, 140),
          href,
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      });
    return candidates;
  });

  const seen = new Set<string>();
  return rawActions
    .map((raw, index) => {
      const risk = classifyActionRisk({
        type: raw.type as CandidateAction["type"],
        label: raw.label,
        href: raw.href,
        startUrl,
        allowExternal: options.allowExternal
      });
      const action: CandidateAction = {
        id: `a-${hashString(`${stateId}:${raw.type}:${raw.selector}:${raw.label}:${index}`).slice(0, 10)}`,
        stateId,
        type: raw.type as CandidateAction["type"],
        selector: raw.selector,
        role: raw.role,
        label: raw.label || raw.text || raw.selector,
        text: raw.text,
        href: raw.href,
        boundingBox: raw.boundingBox,
        risk: risk.risk,
        reason: risk.reason,
        score: 0
      };
      action.score = actionPriority(action);
      return action;
    })
    .filter((action) => {
      const key = `${action.type}:${action.selector}:${action.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 36);
}

async function executeAction(page: Page, action: CandidateAction): Promise<ExecuteResult> {
  const started = Date.now();
  const locator = page.locator(action.selector).first();
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
    if (action.type === "fill") {
      const value = syntheticValue(action);
      await locator.fill(value, { timeout: 2_000 });
      return { status: "changed", replayStep: actionToReplayStep(action, value), durationMs: Date.now() - started };
    }
    if (action.type === "select") {
      const value = await locator.evaluate((element) => {
        const select = element as HTMLSelectElement;
        const option = Array.from(select.options).find((item) => item.value && !item.disabled) ?? select.options[1] ?? select.options[0];
        return option?.value ?? "";
      });
      if (value) await locator.selectOption(value, { timeout: 2_000 });
      return { status: "changed", replayStep: actionToReplayStep(action, value), durationMs: Date.now() - started };
    }
    await locator.click({ timeout: 2_500 });
    return { status: "changed", replayStep: actionToReplayStep(action), durationMs: Date.now() - started };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      replayStep: actionToReplayStep(action),
      durationMs: Date.now() - started
    };
  }
}

async function restoreReplayPath(page: Page, replayPath: ReplayStep[], signal?: AbortSignal): Promise<void> {
  for (const step of replayPath) {
    if (signal?.aborted) break;
    try {
      if (step.type === "goto" && step.url) {
        await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      } else if (step.type === "click" && step.selector) {
        await page.locator(step.selector).first().click({ timeout: 2_000 });
      } else if (step.type === "fill" && step.selector) {
        await page.locator(step.selector).first().fill(step.value ?? "", { timeout: 2_000 });
      } else if (step.type === "select" && step.selector) {
        await page.locator(step.selector).first().selectOption(step.value ?? "", { timeout: 2_000 });
      } else if (step.type === "press" && step.selector) {
        await page.locator(step.selector).first().press(step.key ?? "Enter", { timeout: 2_000 });
      } else if (step.type === "wait") {
        await page.waitForTimeout(step.timeoutMs ?? 250);
      }
      await quickSettle(page);
    } catch {
      break;
    }
  }
}

function registerState(run: CartographRun, state: UIState): RegisterResult {
  const existing = run.states.find((candidate) => areSimilarFingerprints(candidate.fingerprint, state.fingerprint));
  if (existing) {
    return { state: existing, isNew: false };
  }
  const next = { ...state, id: `s${run.states.length + 1}` };
  run.states.push(next);
  run.assets.push({ id: `asset-${next.id}`, type: "screenshot", path: next.screenshotPath, stateId: next.id });
  return { state: next, isNew: true };
}

function enqueueActions(queue: ActionQueueItem[], actions: CandidateAction[], fromStateId: string, replayPath: ReplayStep[], depth: number): void {
  for (const action of actions) {
    queue.push({
      action: { ...action, stateId: fromStateId },
      fromStateId,
      replayPath,
      depth
    });
  }
}

function isActionAllowed(action: CandidateAction, startUrl: string, options: CrawlOptions): boolean {
  const label = (action.label ?? "").toLowerCase();
  if (options.denyActionLabels.some((deny) => label.includes(deny.toLowerCase()))) return false;
  if (options.allowActionLabels.some((allow) => label.includes(allow.toLowerCase()))) return true;
  if (action.risk === "blocked") return false;
  if (action.href && options.sameOriginOnly && !options.allowExternal) {
    const target = new URL(action.href, startUrl);
    const start = new URL(startUrl);
    if (target.origin !== start.origin) return false;
  }
  if (action.risk === "caution" && !options.allowSubmit && !isLocalUrl(startUrl)) return false;
  return true;
}

async function settlePage(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 700 }).catch(() => undefined);
  await page.waitForTimeout(120);
}

async function quickSettle(page: Page): Promise<void> {
  await page.waitForTimeout(45);
}

function syntheticValue(action: CandidateAction): string {
  const label = `${action.label ?? ""} ${action.selector}`.toLowerCase();
  if (label.includes("email")) return "glitchly@example.com";
  if (label.includes("phone")) return "4155550142";
  if (label.includes("zip") || label.includes("postal")) return "94105";
  if (label.includes("card")) return "4242424242424242";
  if (label.includes("cvc") || label.includes("cvv")) return "123";
  if (label.includes("promo")) return "BROKEN500";
  if (label.includes("address")) return "135 Market Street";
  if (label.includes("name")) return "Avery Glitchly";
  return "Glitchly test";
}

function labelState(summary: DomSummary, url: string, title: string): string {
  const heading = summary.headings.find(Boolean);
  if (heading) return heading.slice(0, 48);
  const sample = summary.visibleTextSample.find((item) => item.length > 4);
  if (sample) return sample.slice(0, 48);
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" ? title || "Home" : parsed.pathname;
  } catch {
    return title || "Untitled state";
  }
}

function summarizeRun(run: CartographRun, actionsAttempted: number, durationMs: number, status: RunSummary["status"]): RunSummary {
  const issuesBySeverity = {
    info: run.findings.filter((finding) => finding.severity === "info").length,
    warning: run.findings.filter((finding) => finding.severity === "warning").length,
    critical: run.findings.filter((finding) => finding.severity === "critical").length
  };
  return {
    id: run.id,
    startUrl: run.startUrl,
    createdAt: run.createdAt,
    status,
    durationMs,
    stateCount: run.states.length,
    transitionCount: run.transitions.length,
    findingCount: run.findings.length,
    actionsAttempted,
    viewports: [...new Set(run.states.map((state) => state.viewport))],
    issuesBySeverity
  };
}

function emptySummary(id: string, startUrl: string, createdAt: string, viewports: ViewportConfig[]): RunSummary {
  return {
    id,
    startUrl,
    createdAt,
    status: "completed",
    durationMs: 0,
    stateCount: 0,
    transitionCount: 0,
    findingCount: 0,
    actionsAttempted: 0,
    viewports: viewports.map((viewport) => viewport.name),
    issuesBySeverity: { info: 0, warning: 0, critical: 0 }
  };
}

export async function writeRunArtifacts(run: CartographRun): Promise<void> {
  await mkdir(run.options.outputDir, { recursive: true });
  await mkdir(path.join(run.options.outputDir, "replays"), { recursive: true });
  run.quality = run.quality ?? generateBuildQualityScoreboard(run);
  for (const finding of run.findings) {
    const script = replayScriptForFinding(finding.title, finding.replayPath);
    const replayPath = `replays/${finding.id}.spec.ts`;
    await writeFile(path.join(run.options.outputDir, replayPath), script);
    const replayAssetId = `replay-${finding.id}`;
    if (!run.assets.some((asset) => asset.id === replayAssetId)) {
      run.assets.push({ id: replayAssetId, type: "replay", path: replayPath, findingId: finding.id });
    }
  }
  const json = JSON.stringify(run, null, 2);
  await writeFile(path.join(run.options.outputDir, "run.json"), json);
  await writeFile(path.join(run.options.outputDir, "states.json"), JSON.stringify(run.states, null, 2));
  await writeFile(path.join(run.options.outputDir, "transitions.json"), JSON.stringify(run.transitions, null, 2));
  await writeFile(path.join(run.options.outputDir, "findings.json"), JSON.stringify(run.findings, null, 2));
  await writeFile(path.join(run.options.outputDir, "quality-scoreboard.json"), JSON.stringify(run.quality, null, 2));
  await writeFile(path.join(run.options.outputDir, "report-data.json"), json);
  await writeFile(path.join(run.options.outputDir, "report.md"), generateMarkdownReport(run));
  await writeFile(path.join(run.options.outputDir, "findings-report.md"), generateFindingsMarkdown(run));
  await writeFile(path.join(run.options.outputDir, "findings-export.json"), generateFindingsJson(run));
  await writeFile(path.join(run.options.outputDir, "report.html"), generateStaticHtmlReport(run));
}

function replayScriptForFinding(title: string, replayPath: ReplayStep[]): string {
  const lines = replayPath.map((step) => {
    if (step.type === "goto" && step.url) return `  await page.goto(${JSON.stringify(step.url)});`;
    if (step.type === "click" && step.selector) return `  await page.locator(${JSON.stringify(step.selector)}).click();`;
    if (step.type === "fill" && step.selector) return `  await page.locator(${JSON.stringify(step.selector)}).fill(${JSON.stringify(step.value ?? "")});`;
    if (step.type === "select" && step.selector) return `  await page.locator(${JSON.stringify(step.selector)}).selectOption(${JSON.stringify(step.value ?? "")});`;
    if (step.type === "press" && step.selector) return `  await page.locator(${JSON.stringify(step.selector)}).press(${JSON.stringify(step.key ?? "Enter")});`;
    return `  await page.waitForTimeout(${step.timeoutMs ?? 250});`;
  });
  return `import { test } from "@playwright/test";

test(${JSON.stringify(`replay: ${title}`)}, async ({ page }) => {
${lines.join("\n")}
});
`;
}

function dedupeAgainstRun(existing: unknown[], findings: Awaited<ReturnType<typeof runDetectors>>): Awaited<ReturnType<typeof runDetectors>> {
  const existingIds = new Set((existing as Array<{ id?: string }>).map((item) => item.id).filter(Boolean));
  return findings.filter((finding) => !existingIds.has(finding.id));
}

function slugRunId(startUrl: string): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${slug(startUrl).slice(0, 24)}`;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/https?:\/\//g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "state"
  );
}

export function fileUrlForRun(runDir: string): string {
  return pathToFileURL(path.join(runDir, "report.html")).toString();
}

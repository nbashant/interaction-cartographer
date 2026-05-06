#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cartograph,
  formatBuildQualityStatus,
  generateFindingsJson,
  generateFindingsMarkdown,
  generateMarkdownReport,
  loadRun,
  type CartographRun,
  type CrawlOptions,
  type ScanProgressEvent,
  type ScanProgressSnapshot
} from "@interaction-cartographer/core";
import { numberFromFlag, optionalNumberFromFlag, parseViewports, type Flags } from "./scan-options.js";
import { runAssetPath, safeJoin } from "./server-utils.js";

type ActiveScan = {
  controller: AbortController;
  startedAt: string;
  targetUrl: string;
};
type ReportServerState = {
  runDir: string;
  activeScan: ActiveScan | null;
  progress: ScanProgressSnapshot;
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const userCwd = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : process.cwd();
const maxJsonBodyBytes = 1_000_000;

async function main(): Promise<void> {
  const [rawCommand, ...rest] = process.argv.slice(2);
  const command = rawCommand?.startsWith("http") ? "run" : rawCommand;
  const args = rawCommand?.startsWith("http") ? [rawCommand, ...rest] : rest;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  if (command === "run") {
    await runCommand(args);
    return;
  }
  if (command === "view") {
    await viewCommand(args);
    return;
  }
  if (command === "demo") {
    await demoCommand(args);
    return;
  }
  if (command === "export") {
    await exportCommand(args);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

async function runCommand(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const url = positional[0];
  if (!url) throw new Error("Missing URL. Usage: cartograph run <url>");
  const options = optionsFromFlags(flags, url);
  const run = await cartograph(url, options);
  console.log(`Interaction Cartographer completed ${run.summary.stateCount} states, ${run.summary.transitionCount} transitions, ${run.summary.findingCount} findings.`);
  const passedQualityThreshold = printQualityResult(run, flags);
  console.log(`Artifacts written to ${run.options.outputDir}`);
  if (!passedQualityThreshold) process.exitCode = 1;
}

async function viewCommand(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const runDir = positional[0] ? resolveUserPath(positional[0]) : path.join(rootDir, ".cartograph", "runs", "latest");
  const port = numberFromFlag(flags, "port", defaultPort(), { min: 1, max: 65_535 });
  const host = String(flags.host ?? process.env.HOST ?? "127.0.0.1");
  await serveReport(runDir, { port, host, open: flags.open !== false && flags["no-open"] !== true });
}

async function demoCommand(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const outDir = flags.out ? resolveUserPath(String(flags.out)) : path.join(rootDir, ".cartograph", "runs", "demo");
  const reportPort = numberFromFlag(flags, "port", 4173, { min: 1, max: 65_535 });
  const hubPort = numberFromFlag(flags, "hub-port", 4309, { min: 1, max: 65_535 });
  const atlasPort = numberFromFlag(flags, "atlas-port", 4310, { min: 1, max: 65_535 });
  const checkoutPort = numberFromFlag(flags, "checkout-port", 4311, { min: 1, max: 65_535 });

  buildPackage("@interaction-cartographer/demo-atlas-crm", "apps/demo-atlas-crm/dist");
  buildPackage("@interaction-cartographer/demo-mini-checkout", "apps/demo-mini-checkout/dist");
  buildPackage("@interaction-cartographer/report", "apps/report/dist");

  const atlas = await serveStaticApp(path.join(rootDir, "apps/demo-atlas-crm/dist"), atlasPort, {
    name: "Atlas CRM"
  });
  const checkout = await serveStaticApp(path.join(rootDir, "apps/demo-mini-checkout/dist"), checkoutPort, {
    name: "Mini Checkout",
    promoApi: true
  });
  const hub = await serveDemoHub(hubPort, atlas.url, checkout.url);
  console.log(`Demo apps running: hub ${hub.url}, atlas ${atlas.url}, checkout ${checkout.url}`);

  const run = await cartograph(hub.url, {
    outputDir: outDir,
    maxActions: numberFromFlag(flags, "max-actions", 55, { min: 1, max: 1_000 }),
    maxDepth: numberFromFlag(flags, "max-depth", 7, { min: 0, max: 30 }),
    maxDurationMs: numberFromFlag(flags, "max-duration-ms", 150_000, { min: 1_000, max: 600_000 }),
    viewports: parseViewports(String(flags.viewports ?? "desktop,mobile")),
    allowExternal: true,
    sameOriginOnly: false,
    allowSubmit: true,
    headed: flags.headed === true
  });

  console.log(`Demo crawl completed: ${run.summary.stateCount} states, ${run.summary.transitionCount} transitions, ${run.summary.findingCount} findings.`);
  printQualityResult(run, flags);
  console.log(`Artifacts written to ${run.options.outputDir}`);

  if (flags["no-view"] === true) {
    await closeServers([hub.server, atlas.server, checkout.server]);
    return;
  }

  await serveReport(outDir, { port: reportPort, host: "127.0.0.1", open: flags.open !== false && flags["no-open"] !== true });
}

async function exportCommand(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const runDir = resolveUserPath(positional[0] ?? ".cartograph/runs/demo");
  const format = String(flags.format ?? "json").toLowerCase();
  const run = await loadRun(runDir);
  if (format === "markdown" || format === "md") {
    const out = path.join(runDir, "findings-report.md");
    await writeFile(out, generateFindingsMarkdown(run));
    await writeFile(path.join(runDir, "report.md"), generateMarkdownReport(run));
    console.log(`Markdown findings export written to ${out}`);
    return;
  }
  if (format === "json") {
    const out = path.join(runDir, "findings-export.json");
    await writeFile(out, generateFindingsJson(run));
    console.log(`JSON findings export written to ${out}`);
    return;
  }
  throw new Error(`Unsupported export format: ${format}. Use json or markdown.`);
}

function optionsFromFlags(flags: Flags, url: string): Partial<CrawlOptions> {
  return {
    outputDir: flags.out ? resolveUserPath(String(flags.out)) : undefined,
    maxActions: optionalNumberFromFlag(flags, "max-actions", { min: 1, max: 1_000 }),
    maxDepth: optionalNumberFromFlag(flags, "max-depth", { min: 0, max: 30 }),
    maxDurationMs: optionalNumberFromFlag(flags, "max-duration-ms", { min: 1_000, max: 600_000 }),
    viewports: parseViewports(String(flags.viewports ?? "desktop,mobile")),
    allowExternal: flags["allow-external"] === true,
    sameOriginOnly: flags["allow-external"] === true ? false : true,
    allowSubmit: flags["allow-submit"] === true || url.includes("localhost") || url.includes("127.0.0.1"),
    headed: flags.headed === true
  };
}

function printQualityResult(run: CartographRun, flags: Flags): boolean {
  const quality = run.quality;
  if (!quality) return true;
  const threshold = optionalNumberFromFlag(flags, "quality-threshold", { min: 0, max: 100 });
  console.log(`Build Quality Score: ${quality.overallScore} / 100`);
  console.log(`Status: ${formatBuildQualityStatus(quality.status)}`);
  if (threshold === undefined) {
    const topRisk = quality.topRisks[0];
    if (topRisk) console.log(`Top risk: ${topRisk.title}`);
    return true;
  }
  const passed = quality.overallScore >= threshold;
  console.log(`Threshold: ${threshold}`);
  console.log(`Result: ${passed ? "PASS" : "FAIL"}`);
  const topRisk = quality.topRisks[0];
  if (topRisk) console.log(`Top risk: ${topRisk.title}`);
  return passed;
}

async function serveReport(initialRunDir: string, options: { port: number; host: string; open: boolean }): Promise<Server> {
  buildPackage("@interaction-cartographer/report", "apps/report/dist");
  const distDir = path.join(rootDir, "apps/report/dist");
  const state: ReportServerState = { runDir: initialRunDir, activeScan: null, progress: emptyProgressSnapshot() };
  const server = await listenWithFallback(options.port, options.host, (request, response) => {
    void handleReportRequest(request, response, state, distDir);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const displayHost = options.host === "0.0.0.0" ? "127.0.0.1" : options.host;
  const url = `http://${displayHost}:${port}`;
  console.log(`Interaction Cartographer report running at ${url}`);
  if (options.open) openUrl(url);
  return server;
}

async function handleReportRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: ReportServerState,
  distDir: string
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/run") {
    await sendOptionalJson(response, path.join(state.runDir, "report-data.json"));
    return;
  }
  if (url.pathname === "/api/scan" && request.method === "POST") {
    await handleScanRequest(request, response, state);
    return;
  }
  if (url.pathname === "/api/scan/progress") {
    sendJson(response, currentProgressSnapshot(state));
    return;
  }
  if (url.pathname === "/api/scan/stop" && request.method === "POST") {
    handleStopScanRequest(response, state);
    return;
  }
  if (url.pathname === "/api/export/markdown") {
    await sendFile(response, path.join(state.runDir, "findings-report.md"), "text/markdown; charset=utf-8");
    return;
  }
  if (url.pathname === "/api/export/json") {
    await sendFile(response, path.join(state.runDir, "findings-export.json"), "application/json");
    return;
  }
  if (url.pathname.startsWith("/screenshots/") || url.pathname.startsWith("/replays/")) {
    await sendMaybeFile(response, runAssetPath(state.runDir, url.pathname), mimeFor(url.pathname));
    return;
  }
  const filePath = url.pathname === "/" ? path.join(distDir, "index.html") : safeJoin(distDir, url.pathname);
  if (filePath && existsSync(filePath) && (await stat(filePath)).isFile()) {
    await sendFile(response, filePath, mimeFor(filePath));
    return;
  }
  await sendFile(response, path.join(distDir, "index.html"), "text/html; charset=utf-8");
}

async function handleScanRequest(request: IncomingMessage, response: ServerResponse, state: ReportServerState): Promise<void> {
  let controller: AbortController | null = null;
  try {
    const body = await readJsonBody(request);
    const targetUrl = String(body.url ?? "").trim();
    if (!targetUrl) throw new Error("Missing target URL.");
    if (state.activeScan) {
      const progress = currentProgressSnapshot(state);
      state.progress = progress;
      sendJson(response, {
        error: `A scan is already running for ${state.activeScan.targetUrl}. Stop it before starting another one.`,
        progress
      }, 409);
      return;
    }
    const parsed = new URL(targetUrl);
    if (!isLocalTarget(parsed) && body.allowExternal !== true) {
      throw new Error("The report scanner only scans localhost/127.0.0.1 targets unless allowExternal is explicitly true.");
    }
    const outDir = body.outDir
      ? resolveUserPath(String(body.outDir))
      : path.join(rootDir, ".cartograph", "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug(parsed.host + parsed.pathname)}`);
    await mkdir(outDir, { recursive: true });
    const maxActions = numberFromBody(body, "maxActions", 80, { min: 1, max: 1_000 });
    const maxDepth = numberFromBody(body, "maxDepth", 6, { min: 0, max: 30 });
    const maxDurationMs = numberFromBody(body, "maxDurationMs", 150_000, { min: 1_000, max: 600_000 });
    const viewports = parseViewports(String(body.viewports ?? "desktop,mobile"));
    controller = new AbortController();
    state.activeScan = { controller, startedAt: new Date().toISOString(), targetUrl };
    state.progress = {
      ...emptyProgressSnapshot(),
      active: true,
      phase: "starting",
      message: `Preparing scan for ${targetUrl}`,
      targetUrl,
      maxActions,
      startedAt: state.activeScan.startedAt,
      updatedAt: state.activeScan.startedAt
    };
    const run = await cartograph(targetUrl, {
      outputDir: outDir,
      maxActions,
      maxDepth,
      maxDurationMs,
      viewports,
      allowSubmit: body.allowSubmit !== false,
      allowExternal: body.allowExternal === true,
      sameOriginOnly: body.allowExternal === true ? false : true,
      headed: body.headed === true,
      signal: controller.signal,
      onProgress: (event) => {
        state.progress = progressSnapshotFromEvent(event, state.progress);
      }
    });
    state.runDir = outDir;
    sendJson(response, { run, runDir: outDir, stopped: run.summary.status === "stopped", progress: state.progress });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.progress = progressErrorSnapshot(state.progress, message);
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: message }));
  } finally {
    if (controller && state.activeScan?.controller === controller) {
      state.activeScan = null;
    }
  }
}

function handleStopScanRequest(response: ServerResponse, state: ReportServerState): void {
  if (!state.activeScan) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ stopped: false, message: "No active scan is running." }));
    return;
  }
  state.activeScan.controller.abort();
  state.progress = {
    ...state.progress,
    active: true,
    phase: "writing",
    message: "Stop requested; wrapping partial scan results",
    updatedAt: new Date().toISOString()
  };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ stopped: true, targetUrl: state.activeScan.targetUrl, startedAt: state.activeScan.startedAt }));
}

function emptyProgressSnapshot(): ScanProgressSnapshot {
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

function currentProgressSnapshot(state: ReportServerState): ScanProgressSnapshot {
  if (!state.activeScan) return state.progress;
  const timestamp = new Date().toISOString();
  const stalePhase = state.progress.phase === "idle" || state.progress.phase === "error" || state.progress.phase === "completed" || state.progress.phase === "stopped";
  return {
    ...state.progress,
    active: true,
    phase: stalePhase ? "starting" : state.progress.phase,
    message: stalePhase ? `Preparing scan for ${state.activeScan.targetUrl}` : state.progress.message,
    targetUrl: state.progress.targetUrl ?? state.activeScan.targetUrl,
    startedAt: state.progress.startedAt ?? state.activeScan.startedAt,
    updatedAt: state.progress.updatedAt ?? timestamp
  };
}

function progressSnapshotFromEvent(event: ScanProgressEvent, previous: ScanProgressSnapshot): ScanProgressSnapshot {
  return {
    active: !["completed", "stopped", "error"].includes(event.phase),
    phase: event.phase,
    message: event.message,
    targetUrl: event.targetUrl,
    viewport: event.viewport,
    currentUrl: event.currentUrl,
    currentAction: event.currentAction,
    statesFound: event.statesFound,
    transitionsFound: event.transitionsFound,
    findingsFound: event.findingsFound,
    actionsAttempted: event.actionsAttempted,
    maxActions: event.maxActions,
    startedAt: previous.startedAt ?? event.timestamp,
    updatedAt: event.timestamp,
    recentEvents: [event, ...previous.recentEvents.filter((item) => item.id !== event.id)].slice(0, 8)
  };
}

function progressErrorSnapshot(previous: ScanProgressSnapshot, message: string): ScanProgressSnapshot {
  const timestamp = new Date().toISOString();
  const event: ScanProgressEvent = {
    id: `progress-error-${timestamp}`,
    timestamp,
    phase: "error",
    message,
    targetUrl: previous.targetUrl ?? "unknown",
    viewport: previous.viewport,
    currentUrl: previous.currentUrl,
    currentAction: previous.currentAction,
    statesFound: previous.statesFound,
    transitionsFound: previous.transitionsFound,
    findingsFound: previous.findingsFound,
    actionsAttempted: previous.actionsAttempted,
    maxActions: previous.maxActions
  };
  return progressSnapshotFromEvent(event, previous);
}

async function serveStaticApp(
  distDir: string,
  port: number,
  options: { name: string; promoApi?: boolean }
): Promise<{ server: Server; url: string }> {
  const server = await listenWithFallback(port, "127.0.0.1", (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (options.promoApi && url.pathname === "/api/promo") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Promo service unavailable" }));
      return;
    }
    const filePath = url.pathname === "/" ? path.join(distDir, "index.html") : safeJoin(distDir, url.pathname);
    const target = filePath && existsSync(filePath) ? filePath : path.join(distDir, "index.html");
    void sendFile(response, target, mimeFor(target));
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return { server, url: `http://127.0.0.1:${actualPort}` };
}

async function serveDemoHub(port: number, atlasUrl: string, checkoutUrl: string): Promise<{ server: Server; url: string }> {
  const server = await listenWithFallback(port, "127.0.0.1", (_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Interaction Cartographer Demo Hub</title>
  <style>
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #202736; }
    main { min-height: 100vh; display: grid; place-items: center; }
    section { width: min(680px, calc(100vw - 32px)); background: white; border: 1px solid #d9dee7; border-radius: 8px; padding: 28px; box-shadow: 0 18px 40px rgba(33, 44, 62, .08); }
    h1 { margin: 0 0 10px; font-size: 28px; }
    p { margin: 0 0 20px; color: #667085; }
    a { display: block; padding: 16px 18px; margin: 10px 0; border: 1px solid #d9dee7; border-radius: 8px; color: #1c6f7a; text-decoration: none; font-weight: 700; }
    a:hover { border-color: #1c6f7a; }
  </style>
</head>
<body>
  <main data-cartograph-main>
    <section>
      <h1>Interaction Cartographer Demo Hub</h1>
      <p>Two local demo apps with intentional UI failures.</p>
      <a href="${atlasUrl}" data-cartograph="open-atlas">Open Atlas CRM</a>
      <a href="${checkoutUrl}" data-cartograph="open-checkout">Open Mini Checkout</a>
    </section>
  </main>
</body>
</html>`);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return { server, url: `http://127.0.0.1:${actualPort}` };
}

function buildPackage(packageName: string, distRelativePath: string): void {
  const dist = path.join(rootDir, distRelativePath);
  if (!existsSync(dist)) console.log(`Building ${packageName}...`);
  execFileSync("npm", ["run", "-w", packageName, "build"], { cwd: rootDir, stdio: "inherit" });
}

async function listenWithFallback(port: number, host: string, handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<Server> {
  for (let candidate = port; candidate < port + 30; candidate += 1) {
    const server = http.createServer(handler);
    const started = await new Promise<Server | undefined>((resolve) => {
      server.once("error", () => resolve(undefined));
      server.listen(candidate, host, () => resolve(server));
    });
    if (started) return started;
  }
  throw new Error(`No available port found starting at ${port}`);
}

async function sendFile(response: ServerResponse, filePath: string, contentType: string): Promise<void> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    response.writeHead(200, { "content-type": contentType, "x-content-type-options": "nosniff" });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function sendJson(response: ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function sendMaybeFile(response: ServerResponse, filePath: string | null, contentType: string): Promise<void> {
  if (!filePath) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  await sendFile(response, filePath, contentType);
}

async function sendOptionalJson(response: ServerResponse, filePath: string): Promise<void> {
  try {
    await stat(filePath);
    await sendFile(response, filePath, "application/json");
  } catch {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("null");
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maxJsonBodyBytes) throw new Error("Request body too large.");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function numberFromBody(body: Record<string, unknown>, key: string, fallback: number, limits: { min: number; max: number }): number {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < limits.min || value > limits.max) {
    throw new Error(`${key} must be a number between ${limits.min} and ${limits.max}.`);
  }
  return Math.floor(value);
}

function isLocalTarget(url: URL): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
}

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".md") return "text/markdown; charset=utf-8";
  return "application/octet-stream";
}

function parseArgs(args: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name.startsWith("no-")) {
      flags[name] = true;
      flags[name.slice(3)] = false;
      continue;
    }
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags[name] = true;
      continue;
    }
    flags[name] = next;
    index += 1;
  }
  return { positional, flags };
}

function openUrl(url: string): void {
  if (process.platform !== "darwin") return;
  try {
    execFileSync("open", [url], { stdio: "ignore" });
  } catch {
    // Opening a browser is a convenience; serving the report is the contract.
  }
}

async function closeServers(servers: Server[]): Promise<void> {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
}

function printHelp(): void {
  console.log(`Interaction Cartographer

Usage:
  cartograph run <url> [--out .cartograph/runs/my-app] [--viewports desktop,mobile] [--max-actions 150] [--max-depth 6] [--quality-threshold 75] [--headed]
  cartograph view [run-dir] [--port 4173] [--host 127.0.0.1] [--no-open]
  cartograph demo [--out .cartograph/runs/demo] [--no-open] [--no-view]
  cartograph export <run-dir> --format json|markdown [--include-quality]

Examples:
  cartograph view
  cartograph run http://localhost:3000 --out .cartograph/runs/my-app
  cartograph export .cartograph/runs/my-app --format json
`);
}

function defaultPort(): number {
  const raw = process.env.PORT;
  if (!raw) return 4173;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : 4173;
}

function resolveUserPath(input: string): string {
  return path.isAbsolute(input) ? input : path.resolve(userCwd, input);
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/https?:\/\//g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "scan"
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
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
import { runAssetPath, safeJoin, uploadableRunArtifactPath } from "./server-utils.js";

type ActiveScan = {
  controller: AbortController;
  startedAt: string;
  targetUrl: string;
};
type AgentScanOptions = {
  url: string;
  maxActions: number;
  maxDepth: number;
  maxDurationMs: number;
  viewports: string;
  allowSubmit: boolean;
  allowExternal: boolean;
  headed: boolean;
};
type AgentTask =
  | {
      id: string;
      type: "scan";
      createdAt: string;
      payload: AgentScanOptions;
    }
  | {
      id: string;
      type: "stop";
      createdAt: string;
    };
type AgentSessionStatus = "waiting" | "connected" | "disconnected" | "expired";
type AgentSession = {
  id: string;
  code: string;
  createdAt: string;
  expiresAt: string;
  status: AgentSessionStatus;
  agentId?: string;
  agentName?: string;
  lastSeenAt?: string;
  lastUiSeenAt?: string;
  activeTaskId?: string;
  tasks: AgentTask[];
  progress: ScanProgressSnapshot;
  pendingRunDir?: string;
  runDir?: string;
  artifactBytesUploaded?: number;
};
type LegacyUploadedRunFile = {
  path: string;
  contentBase64: string;
};
type UploadedRunManifestFile = {
  path: string;
  size: number;
  chunks: number;
};
type UploadedRunManifest = {
  files: UploadedRunManifestFile[];
  totalBytes: number;
};
type ReportServerState = {
  runDir: string;
  activeScan: ActiveScan | null;
  progress: ScanProgressSnapshot;
  agentSessions: Map<string, AgentSession>;
  agentSessionsByCode: Map<string, string>;
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const userCwd = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : process.cwd();
const maxJsonBodyBytes = 1_000_000;
const maxAgentResultBodyBytes = 90_000_000;
const maxAgentArtifactChunkBytes = 6_000_000;
const maxAgentArtifactSessionBytes = numberFromEnv("CARTOGRAPH_MAX_AGENT_ARTIFACT_BYTES", 750_000_000);
const agentSessionTtlMs = 10 * 60 * 1000;
const agentUiStaleMs = 5 * 60 * 1000;
const agentPollMs = 900;
const agentArtifactRoot = path.join(os.tmpdir(), "glitchly-sessions");

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
  if (command === "connect" || command === "scan-ui") {
    await connectCommand(args);
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
  console.log(`Glitchly completed ${run.summary.stateCount} states, ${run.summary.transitionCount} transitions, ${run.summary.findingCount} findings.`);
  const passedQualityThreshold = printQualityResult(run, flags);
  console.log(`Artifacts written to ${run.options.outputDir}`);
  if (!passedQualityThreshold) process.exitCode = 1;
}

async function viewCommand(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const runDir = positional[0] ? resolveUserPath(positional[0]) : path.join(rootDir, ".glitchly", "runs", "latest");
  const port = numberFromFlag(flags, "port", defaultPort(), { min: 1, max: 65_535 });
  const host = String(flags.host ?? process.env.HOST ?? "127.0.0.1");
  await serveReport(runDir, { port, host, open: flags.open !== false && flags["no-open"] !== true });
}

async function demoCommand(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const outDir = flags.out ? resolveUserPath(String(flags.out)) : path.join(rootDir, ".glitchly", "runs", "demo");
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
  const runDir = resolveUserPath(positional[0] ?? ".glitchly/runs/demo");
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

async function connectCommand(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const pairCode = String(flags.pair ?? positional[0] ?? "").trim().toUpperCase();
  if (!pairCode) throw new Error("Missing pairing code. Usage: cartograph connect --pair 8K4P-JD91 --server https://glitchly-app.onrender.com");
  const serverUrl = normalizeServerUrl(String(flags.server ?? flags.host ?? "https://glitchly-app.onrender.com"));
  const agentName = String(flags.name ?? os.hostname());
  const connected = await postJson<{ sessionId: string; agentId: string; pollMs?: number }>(`${serverUrl}/api/agent/connect`, {
    code: pairCode,
    agentName,
    version: "0.1.2"
  });
  const agentId = connected.agentId;
  const sessionId = connected.sessionId;
  const pollMs = connected.pollMs ?? agentPollMs;
  let activeScan: Promise<void> | null = null;
  const activeControllerRef: { current: AbortController | null } = { current: null };
  let shuttingDown = false;

  console.log(`Local companion connected to ${serverUrl}`);
  console.log(`Session ${sessionId}. Keep this terminal open while scanning.`);

  const disconnect = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    activeControllerRef.current?.abort();
    try {
      await postJson(`${serverUrl}/api/agent/disconnect`, { sessionId, agentId });
    } catch {
      // The process is already exiting; disconnect is best-effort.
    }
  };
  process.once("SIGINT", () => {
    void disconnect().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void disconnect().finally(() => process.exit(0));
  });

  while (!shuttingDown) {
    try {
      const response = await getJson<{ tasks: AgentTask[]; pollMs?: number }>(
        `${serverUrl}/api/agent/tasks?sessionId=${encodeURIComponent(sessionId)}&agentId=${encodeURIComponent(agentId)}`
      );
      for (const task of response.tasks) {
        if (task.type === "stop") {
          if (activeControllerRef.current) {
            console.log("Stop requested from hosted UI.");
            activeControllerRef.current.abort();
          }
          continue;
        }
        if (task.type === "scan") {
          if (activeScan) {
            await postJson(`${serverUrl}/api/agent/result`, {
              sessionId,
              agentId,
              taskId: task.id,
              error: "A local scan is already running."
            });
            continue;
          }
          activeScan = runAgentScan(serverUrl, sessionId, agentId, task, (controller) => {
            activeControllerRef.current = controller;
          }).finally(() => {
            activeControllerRef.current = null;
            activeScan = null;
          });
        }
      }
    } catch (error) {
      console.error(`Companion poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await delay(pollMs);
  }
}

async function runAgentScan(
  serverUrl: string,
  sessionId: string,
  agentId: string,
  task: Extract<AgentTask, { type: "scan" }>,
  setController: (controller: AbortController) => void
): Promise<void> {
  const payload = task.payload;
  const parsed = new URL(payload.url);
  if (!isLocalTarget(parsed) && !payload.allowExternal) {
    await postJson(`${serverUrl}/api/agent/result`, {
      sessionId,
      agentId,
      taskId: task.id,
      error: "The local companion only scans localhost/127.0.0.1 targets unless external links are explicitly allowed."
    });
    return;
  }
  const outputDir = path.join(userCwd, ".glitchly", "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-agent-${slug(parsed.host + parsed.pathname)}`);
  const controller = new AbortController();
  setController(controller);
  console.log(`Scanning ${payload.url}`);
  try {
    const run = await cartograph(payload.url, {
      outputDir,
      maxActions: payload.maxActions,
      maxDepth: payload.maxDepth,
      maxDurationMs: payload.maxDurationMs,
      viewports: parseViewports(payload.viewports),
      allowSubmit: payload.allowSubmit,
      allowExternal: payload.allowExternal,
      sameOriginOnly: payload.allowExternal ? false : true,
      headed: payload.headed,
      signal: controller.signal,
      onProgress: (event) => {
        void postJson(`${serverUrl}/api/agent/progress`, { sessionId, agentId, taskId: task.id, event }).catch((error) => {
          console.error(`Progress upload failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    });
    const manifest = await uploadRunArtifacts(serverUrl, sessionId, agentId, task.id, outputDir, run);
    await postJson(`${serverUrl}/api/agent/result`, { sessionId, agentId, taskId: task.id, run, manifest });
    console.log(`Uploaded ${run.summary.findingCount} findings and ${formatBytes(manifest.totalBytes)} of evidence from ${outputDir}`);
  } catch (error) {
    await postJson(`${serverUrl}/api/agent/result`, {
      sessionId,
      agentId,
      taskId: task.id,
      error: error instanceof Error ? error.message : String(error)
    }).catch(() => undefined);
    console.error(`Scan failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function uploadRunArtifacts(
  serverUrl: string,
  sessionId: string,
  agentId: string,
  taskId: string,
  outputDir: string,
  run: CartographRun
): Promise<UploadedRunManifest> {
  const files = await collectUploadableRunFiles(outputDir);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  await postJson(`${serverUrl}/api/agent/progress`, {
    sessionId,
    agentId,
    taskId,
    event: {
      id: randomId("progress"),
      timestamp: new Date().toISOString(),
      phase: "writing",
      message: `Uploading ${files.length} temporary evidence artifact(s) to the hosted UI`,
      targetUrl: run.startUrl,
      statesFound: run.summary.stateCount,
      transitionsFound: run.summary.transitionCount,
      findingsFound: run.summary.findingCount,
      actionsAttempted: run.summary.actionsAttempted,
      maxActions: run.options.maxActions
    } satisfies ScanProgressEvent
  }).catch(() => undefined);
  for (const file of files) {
    await uploadRunArtifactFile(serverUrl, sessionId, agentId, taskId, file);
  }
  return {
    files: files.map((file) => ({ path: file.relativePath, size: file.size, chunks: Math.max(1, Math.ceil(file.size / maxAgentArtifactChunkBytes)) })),
    totalBytes
  };
}

type UploadableRunFile = {
  filePath: string;
  relativePath: string;
  size: number;
};

async function collectUploadableRunFiles(outputDir: string): Promise<UploadableRunFile[]> {
  const files: UploadableRunFile[] = [];
  const visit = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const fileStat = await stat(filePath);
      const relativePath = path.relative(outputDir, filePath).split(path.sep).join("/");
      const uploadPath = uploadableRunArtifactPath(relativePath);
      if (!uploadPath) continue;
      files.push({ filePath, relativePath: uploadPath, size: fileStat.size });
    }
  };
  await visit(outputDir);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function uploadRunArtifactFile(
  serverUrl: string,
  sessionId: string,
  agentId: string,
  taskId: string,
  file: UploadableRunFile
): Promise<void> {
  const chunks = Math.max(1, Math.ceil(file.size / maxAgentArtifactChunkBytes));
  const handle = await open(file.filePath, "r");
  try {
    for (let index = 0; index < chunks; index += 1) {
      const offset = index * maxAgentArtifactChunkBytes;
      const length = Math.min(maxAgentArtifactChunkBytes, file.size - offset);
      const buffer = Buffer.alloc(length);
      if (length > 0) {
        const result = await handle.read(buffer, 0, length, offset);
        if (result.bytesRead !== length) throw new Error(`Unable to read ${file.relativePath} for upload.`);
      }
      await postBinary(agentArtifactUploadUrl(serverUrl, sessionId, agentId, taskId, file.relativePath, index, chunks), buffer);
    }
  } finally {
    await handle.close();
  }
}

function agentArtifactUploadUrl(serverUrl: string, sessionId: string, agentId: string, taskId: string, relativePath: string, index: number, total: number): string {
  const params = new URLSearchParams({ sessionId, agentId, taskId, path: relativePath, index: String(index), total: String(total) });
  return `${serverUrl}/api/agent/artifact?${params.toString()}`;
}

async function postBinary<T = unknown>(url: string, payload: Buffer): Promise<T> {
  const body = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body
  });
  return parseJsonResponse<T>(response, maxJsonBodyBytes);
}

async function postJson<T = unknown>(url: string, payload: unknown, maxResponseBytes = maxJsonBodyBytes): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return parseJsonResponse<T>(response, maxResponseBytes);
}

async function getJson<T = unknown>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  return parseJsonResponse<T>(response, maxJsonBodyBytes);
}

async function parseJsonResponse<T>(response: Response, maxResponseBytes: number): Promise<T> {
  const text = await response.text();
  if (text.length > maxResponseBytes) throw new Error("Response body too large.");
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

function normalizeServerUrl(value: string): string {
  const withProtocol = value.startsWith("http://") || value.startsWith("https://") ? value : `https://${value}`;
  return withProtocol.replace(/\/+$/, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const state: ReportServerState = {
    runDir: initialRunDir,
    activeScan: null,
    progress: emptyProgressSnapshot(),
    agentSessions: new Map(),
    agentSessionsByCode: new Map()
  };
  const server = await listenWithFallback(options.port, options.host, (request, response) => {
    void handleReportRequest(request, response, state, distDir);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const displayHost = options.host === "0.0.0.0" ? "127.0.0.1" : options.host;
  const url = `http://${displayHost}:${port}`;
  console.log(`Glitchly report running at ${url}`);
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
    const runDir = runDirForRequest(state, url);
    if (url.searchParams.has("sessionId") && !runDir) {
      sendJson(response, null);
      return;
    }
    await sendOptionalJson(response, path.join(runDir ?? state.runDir, "report-data.json"));
    return;
  }
  if (url.pathname === "/api/agent/session") {
    await handleAgentSessionRequest(request, response, state, url);
    return;
  }
  if (url.pathname === "/api/agent/connect" && request.method === "POST") {
    await handleAgentConnectRequest(request, response, state);
    return;
  }
  if (url.pathname === "/api/agent/tasks") {
    handleAgentTasksRequest(response, state, url);
    return;
  }
  if (url.pathname === "/api/agent/progress" && request.method === "POST") {
    await handleAgentProgressRequest(request, response, state);
    return;
  }
  if (url.pathname === "/api/agent/artifact" && request.method === "PUT") {
    await handleAgentArtifactRequest(request, response, state, url);
    return;
  }
  if (url.pathname === "/api/agent/result" && request.method === "POST") {
    await handleAgentResultRequest(request, response, state);
    return;
  }
  if (url.pathname === "/api/agent/disconnect" && request.method === "POST") {
    await handleAgentDisconnectRequest(request, response, state);
    return;
  }
  if (url.pathname === "/api/scan" && request.method === "POST") {
    await handleScanRequest(request, response, state);
    return;
  }
  if (url.pathname === "/api/scan/progress") {
    sendJson(response, progressForRequest(state, url));
    return;
  }
  if (url.pathname === "/api/scan/stop" && request.method === "POST") {
    await handleStopScanRequest(request, response, state);
    return;
  }
  if (url.pathname === "/api/export/markdown") {
    const runDir = runDirForRequest(state, url);
    if (url.searchParams.has("sessionId") && !runDir) {
      sendJson(response, { error: "No run is available for this paired session." }, 404);
      return;
    }
    await sendFile(response, path.join(runDir ?? state.runDir, "findings-report.md"), "text/markdown; charset=utf-8");
    return;
  }
  if (url.pathname === "/api/export/json") {
    const runDir = runDirForRequest(state, url);
    if (url.searchParams.has("sessionId") && !runDir) {
      sendJson(response, { error: "No run is available for this paired session." }, 404);
      return;
    }
    await sendFile(response, path.join(runDir ?? state.runDir, "findings-export.json"), "application/json");
    return;
  }
  if (url.pathname.startsWith("/screenshots/") || url.pathname.startsWith("/replays/")) {
    const runDir = runDirForRequest(state, url);
    if (url.searchParams.has("sessionId") && !runDir) {
      await sendMaybeFile(response, null, mimeFor(url.pathname));
      return;
    }
    await sendMaybeFile(response, runAssetPath(runDir ?? state.runDir, url.pathname), mimeFor(url.pathname));
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
    const parsed = new URL(targetUrl);
    const agentSession = sessionFromBody(state, body);
    if (agentSession) {
      await handleAgentBackedScanRequest(response, agentSession, body, targetUrl);
      return;
    }
    if (isPublicRequest(request) && isLocalTarget(parsed)) {
      sendJson(response, {
        error: "Connect the local companion before scanning a localhost app from the hosted UI.",
        requiresAgent: true,
        progress: emptyProgressSnapshot()
      }, 409);
      return;
    }
    if (state.activeScan) {
      const progress = currentProgressSnapshot(state);
      state.progress = progress;
      sendJson(response, {
        error: `A scan is already running for ${state.activeScan.targetUrl}. Stop it before starting another one.`,
        progress
      }, 409);
      return;
    }
    if (!isLocalTarget(parsed) && body.allowExternal !== true) {
      throw new Error("The report scanner only scans localhost/127.0.0.1 targets unless allowExternal is explicitly true.");
    }
    const outDir = body.outDir
      ? resolveUserPath(String(body.outDir))
      : path.join(rootDir, ".glitchly", "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug(parsed.host + parsed.pathname)}`);
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

async function handleAgentSessionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: ReportServerState,
  url: URL
): Promise<void> {
  cleanupAgentSessions(state);
  let sessionId = url.searchParams.get("sessionId") ?? "";
  if (request.method === "POST") {
    const body: Record<string, unknown> = await readJsonBody(request).catch(() => ({}));
    sessionId = String(body.sessionId ?? sessionId ?? "");
  }
  let session = sessionId ? state.agentSessions.get(sessionId) : undefined;
  if (!session || session.status === "expired") {
    session = createAgentSession(state);
  }
  session.lastUiSeenAt = new Date().toISOString();
  refreshAgentPresence(session);
  sendJson(response, publicAgentSession(session));
}

async function handleAgentConnectRequest(request: IncomingMessage, response: ServerResponse, state: ReportServerState): Promise<void> {
  cleanupAgentSessions(state);
  const body = await readJsonBody(request);
  const code = String(body.code ?? "").trim().toUpperCase();
  const sessionId = state.agentSessionsByCode.get(code);
  const session = sessionId ? state.agentSessions.get(sessionId) : undefined;
  if (!session || session.status === "expired") {
    sendJson(response, { error: "Pairing code is invalid or expired." }, 404);
    return;
  }
  const timestamp = new Date().toISOString();
  session.status = "connected";
  session.agentId = randomId("agent");
  session.agentName = String(body.agentName ?? "Local companion").slice(0, 80);
  session.lastSeenAt = timestamp;
  session.progress = {
    ...emptyProgressSnapshot(),
    phase: "idle",
    message: "Local companion connected.",
    updatedAt: timestamp
  };
  sendJson(response, { sessionId: session.id, agentId: session.agentId, pollMs: agentPollMs });
}

function handleAgentTasksRequest(response: ServerResponse, state: ReportServerState, url: URL): void {
  cleanupAgentSessions(state);
  const session = authenticatedAgentSession(state, url.searchParams.get("sessionId"), url.searchParams.get("agentId"));
  if (!session) {
    sendJson(response, { error: "Agent session not found." }, 404);
    return;
  }
  session.lastSeenAt = new Date().toISOString();
  session.status = "connected";
  const tasks = session.tasks.splice(0, session.tasks.length);
  sendJson(response, { tasks, pollMs: agentPollMs });
}

async function handleAgentProgressRequest(request: IncomingMessage, response: ServerResponse, state: ReportServerState): Promise<void> {
  const body = await readJsonBody(request);
  const session = authenticatedAgentSession(state, String(body.sessionId ?? ""), String(body.agentId ?? ""));
  if (!session) {
    sendJson(response, { error: "Agent session not found." }, 404);
    return;
  }
  const event = body.event as ScanProgressEvent | undefined;
  if (!event || typeof event.message !== "string") {
    sendJson(response, { error: "Missing progress event." }, 400);
    return;
  }
  session.lastSeenAt = new Date().toISOString();
  session.status = "connected";
  session.activeTaskId = String(body.taskId ?? session.activeTaskId ?? "");
  session.progress = progressSnapshotFromEvent(event, session.progress);
  sendJson(response, { ok: true });
}

async function handleAgentArtifactRequest(request: IncomingMessage, response: ServerResponse, state: ReportServerState, url: URL): Promise<void> {
  const session = authenticatedAgentSession(state, url.searchParams.get("sessionId"), url.searchParams.get("agentId"));
  if (!session) {
    sendJson(response, { error: "Agent session not found." }, 404);
    return;
  }
  const taskId = String(url.searchParams.get("taskId") ?? "");
  if (!taskId || session.activeTaskId !== taskId) {
    sendJson(response, { error: "Artifact upload does not match the active scan." }, 409);
    return;
  }
  const relativePath = uploadableRunArtifactPath(String(url.searchParams.get("path") ?? ""));
  if (!relativePath) {
    sendJson(response, { error: "Artifact path is not uploadable." }, 400);
    return;
  }
  let chunkIndex: number;
  let totalChunks: number;
  try {
    chunkIndex = numberFromSearchParam(url, "index", 0, { min: 0, max: 100_000 });
    totalChunks = numberFromSearchParam(url, "total", 1, { min: 1, max: 100_001 });
  } catch (error) {
    sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 400);
    return;
  }
  if (chunkIndex >= totalChunks) {
    sendJson(response, { error: "Artifact chunk index is outside the chunk count." }, 400);
    return;
  }

  let body: Buffer;
  try {
    body = await readBinaryBody(request, maxAgentArtifactChunkBytes);
  } catch (error) {
    sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 413);
    return;
  }
  session.lastSeenAt = new Date().toISOString();
  session.status = "connected";
  const nextTotal = (session.artifactBytesUploaded ?? 0) + body.byteLength;
  if (nextTotal > maxAgentArtifactSessionBytes) {
    session.progress = progressErrorSnapshot(session.progress, `Temporary artifact upload exceeded ${formatBytes(maxAgentArtifactSessionBytes)} for this scan.`);
    sendJson(response, { error: session.progress.message }, 413);
    return;
  }

  const runDir = session.pendingRunDir ?? agentRunDir(session.id, taskId);
  session.pendingRunDir = runDir;
  const filePath = safeRunFilePath(runDir, relativePath);
  if (!filePath) {
    sendJson(response, { error: "Artifact path is unsafe." }, 400);
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  if (chunkIndex === 0) {
    await writeFile(filePath, body);
  } else {
    await appendFile(filePath, body);
  }
  session.artifactBytesUploaded = nextTotal;
  sendJson(response, { ok: true, receivedBytes: body.byteLength, totalBytes: nextTotal });
}

async function handleAgentResultRequest(request: IncomingMessage, response: ServerResponse, state: ReportServerState): Promise<void> {
  const body = await readJsonBody(request, maxAgentResultBodyBytes);
  const session = authenticatedAgentSession(state, String(body.sessionId ?? ""), String(body.agentId ?? ""));
  if (!session) {
    sendJson(response, { error: "Agent session not found." }, 404);
    return;
  }
  session.lastSeenAt = new Date().toISOString();
  session.status = "connected";
  if (typeof body.error === "string" && body.error) {
    await clearAgentSessionArtifacts(session);
    session.activeTaskId = undefined;
    session.progress = progressErrorSnapshot(session.progress, body.error);
    sendJson(response, { ok: true });
    return;
  }
  const files = Array.isArray(body.files) ? (body.files as LegacyUploadedRunFile[]) : [];
  const taskId = String(body.taskId ?? session.activeTaskId ?? "latest");
  const run = body.run as CartographRun | undefined;
  const runDir = session.pendingRunDir ?? session.runDir ?? agentRunDir(session.id, taskId);
  if (!run) {
    session.activeTaskId = undefined;
    session.progress = progressErrorSnapshot(session.progress, "Local companion did not upload run artifacts.");
    sendJson(response, { error: "Missing run artifacts." }, 400);
    return;
  }
  await mkdir(runDir, { recursive: true });
  for (const file of files) {
    const filePath = safeRunFilePath(runDir, file.path);
    if (!filePath) continue;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from(file.contentBase64, "base64"));
  }
  await writeFinalRunFiles(runDir, run);
  session.activeTaskId = undefined;
  session.pendingRunDir = undefined;
  session.runDir = runDir;
  state.runDir = runDir;
  const timestamp = new Date().toISOString();
  session.progress = progressSnapshotFromEvent({
    id: randomId("progress"),
    timestamp,
    phase: run.summary.status === "stopped" ? "stopped" : "completed",
    message: run.summary.status === "stopped" ? "Scan stopped; partial results are ready." : "Scan completed; findings are ready.",
    targetUrl: run.startUrl,
    statesFound: run.summary.stateCount,
    transitionsFound: run.summary.transitionCount,
    findingsFound: run.summary.findingCount,
    actionsAttempted: run.summary.actionsAttempted,
    maxActions: session.progress.maxActions
  }, session.progress);
  sendJson(response, { ok: true });
}

async function handleAgentDisconnectRequest(request: IncomingMessage, response: ServerResponse, state: ReportServerState): Promise<void> {
  const body: Record<string, unknown> = await readJsonBody(request).catch(() => ({}));
  const session = authenticatedAgentSession(state, String(body.sessionId ?? ""), String(body.agentId ?? ""));
  if (!session) {
    sendJson(response, { ok: true });
    return;
  }
  session.status = "disconnected";
  session.lastSeenAt = new Date().toISOString();
  if (session.progress.active) {
    session.progress = progressErrorSnapshot(session.progress, "Local companion disconnected.");
  }
  sendJson(response, { ok: true });
}

async function handleAgentBackedScanRequest(response: ServerResponse, session: AgentSession, body: Record<string, unknown>, targetUrl: string): Promise<void> {
  if (session.status !== "connected" || !session.agentId) {
    sendJson(response, { error: "Local companion is not connected.", requiresAgent: true, progress: session.progress }, 409);
    return;
  }
  if (session.progress.active || session.activeTaskId) {
    sendJson(response, {
      error: `A scan is already running for ${session.progress.targetUrl ?? targetUrl}. Stop it before starting another one.`,
      progress: session.progress
    }, 409);
    return;
  }
  const options = agentScanOptionsFromBody(body, targetUrl);
  const task: AgentTask = { id: randomId("task"), type: "scan", createdAt: new Date().toISOString(), payload: options };
  await clearAgentSessionArtifacts(session);
  session.tasks.push(task);
  session.activeTaskId = task.id;
  session.progress = {
    ...emptyProgressSnapshot(),
    active: true,
    phase: "starting",
    message: `Queued scan for local companion: ${targetUrl}`,
    targetUrl,
    maxActions: options.maxActions,
    startedAt: task.createdAt,
    updatedAt: task.createdAt
  };
  sendJson(response, { queued: true, viaAgent: true, progress: session.progress }, 202);
}

async function handleStopScanRequest(request: IncomingMessage, response: ServerResponse, state: ReportServerState): Promise<void> {
  const body = await readJsonBody(request).catch(() => ({}));
  const agentSession = sessionFromBody(state, body);
  if (agentSession) {
    if (agentSession.status !== "connected") {
      sendJson(response, { stopped: false, message: "Local companion is not connected." });
      return;
    }
    if (!agentSession.progress.active && !agentSession.activeTaskId) {
      sendJson(response, { stopped: false, message: "No active scan is running." });
      return;
    }
    const task: AgentTask = { id: randomId("task"), type: "stop", createdAt: new Date().toISOString() };
    agentSession.tasks.push(task);
    agentSession.progress = {
      ...agentSession.progress,
      active: true,
      phase: "writing",
      message: "Stop requested; waiting for local companion to wrap partial scan results",
      updatedAt: task.createdAt
    };
    sendJson(response, { stopped: true, viaAgent: true, targetUrl: agentSession.progress.targetUrl, startedAt: agentSession.progress.startedAt });
    return;
  }
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

function createAgentSession(state: ReportServerState): AgentSession {
  const createdAt = new Date();
  const session: AgentSession = {
    id: randomId("session"),
    code: pairCode(),
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + agentSessionTtlMs).toISOString(),
    status: "waiting",
    tasks: [],
    progress: emptyProgressSnapshot()
  };
  state.agentSessions.set(session.id, session);
  state.agentSessionsByCode.set(session.code, session.id);
  return session;
}

function cleanupAgentSessions(state: ReportServerState): void {
  const now = Date.now();
  for (const session of state.agentSessions.values()) {
    const expiredBeforeConnect = session.status === "waiting" && Date.parse(session.expiresAt) < now;
    const disconnectedTooLong = session.status === "disconnected" && session.lastSeenAt && Date.parse(session.lastSeenAt) + agentSessionTtlMs < now;
    const uiStale = session.lastUiSeenAt && Date.parse(session.lastUiSeenAt) + agentUiStaleMs < now && !session.progress.active && !session.activeTaskId;
    if (!expiredBeforeConnect && !disconnectedTooLong && !uiStale) continue;
    session.status = "expired";
    void clearAgentSessionArtifacts(session);
    state.agentSessions.delete(session.id);
    state.agentSessionsByCode.delete(session.code);
  }
}

function publicAgentSession(session: AgentSession) {
  return {
    sessionId: session.id,
    pairCode: session.code,
    expiresAt: session.expiresAt,
    status: session.status,
    connected: session.status === "connected",
    agentName: session.agentName,
    lastSeenAt: session.lastSeenAt,
    progress: session.progress
  };
}

function authenticatedAgentSession(state: ReportServerState, sessionId: string | null, agentId: string | null): AgentSession | null {
  if (!sessionId || !agentId) return null;
  const session = state.agentSessions.get(sessionId);
  if (!session || session.agentId !== agentId || session.status === "expired") return null;
  return session;
}

function sessionFromBody(state: ReportServerState, body: Record<string, unknown>): AgentSession | null {
  const sessionId = String(body.sessionId ?? "");
  if (!sessionId) return null;
  return state.agentSessions.get(sessionId) ?? null;
}

function runDirForRequest(state: ReportServerState, url: URL): string | null {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return null;
  return state.agentSessions.get(sessionId)?.runDir ?? null;
}

function progressForRequest(state: ReportServerState, url: URL): ScanProgressSnapshot {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return currentProgressSnapshot(state);
  const session = state.agentSessions.get(sessionId);
  if (session) refreshAgentPresence(session);
  return session?.progress ?? emptyProgressSnapshot();
}

function agentScanOptionsFromBody(body: Record<string, unknown>, targetUrl: string): AgentScanOptions {
  const viewports = String(body.viewports ?? "desktop,mobile");
  parseViewports(viewports);
  return {
    url: targetUrl,
    maxActions: numberFromBody(body, "maxActions", 80, { min: 1, max: 1_000 }),
    maxDepth: numberFromBody(body, "maxDepth", 6, { min: 0, max: 30 }),
    maxDurationMs: numberFromBody(body, "maxDurationMs", 150_000, { min: 1_000, max: 600_000 }),
    viewports,
    allowSubmit: body.allowSubmit !== false,
    allowExternal: body.allowExternal === true,
    headed: body.headed === true
  };
}

function agentRunDir(sessionId: string, taskId: string): string {
  return path.join(agentArtifactRoot, sessionId, taskId);
}

async function clearAgentSessionArtifacts(session: AgentSession): Promise<void> {
  session.pendingRunDir = undefined;
  session.runDir = undefined;
  session.artifactBytesUploaded = 0;
  await rm(path.join(agentArtifactRoot, session.id), { recursive: true, force: true }).catch(() => undefined);
}

async function writeFinalRunFiles(runDir: string, run: CartographRun): Promise<void> {
  const json = JSON.stringify(run, null, 2);
  await Promise.all([
    writeFile(path.join(runDir, "run.json"), json),
    writeFile(path.join(runDir, "report-data.json"), json),
    writeFile(path.join(runDir, "findings-report.md"), generateFindingsMarkdown(run)),
    writeFile(path.join(runDir, "report.md"), generateMarkdownReport(run)),
    writeFile(path.join(runDir, "findings-export.json"), generateFindingsJson(run))
  ]);
}

function isPublicRequest(request: IncomingMessage): boolean {
  const host = String(request.headers.host ?? "").split(":")[0].toLowerCase();
  return Boolean(host && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host));
}

function safeRunFilePath(root: string, relativePath: string): string | null {
  const normalized = relativePath.replace(/^[/\\]+/, "");
  if (!normalized || normalized.includes("\0")) return null;
  const filePath = path.resolve(root, normalized);
  const resolvedRoot = path.resolve(root);
  if (filePath !== resolvedRoot && !filePath.startsWith(`${resolvedRoot}${path.sep}`)) return null;
  return filePath;
}

function randomId(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

function refreshAgentPresence(session: AgentSession): void {
  if (session.status !== "connected" || !session.lastSeenAt) return;
  if (Date.now() - Date.parse(session.lastSeenAt) < agentPollMs * 6) return;
  session.status = "disconnected";
  if (session.progress.active) {
    session.progress = progressErrorSnapshot(session.progress, "Local companion connection was lost.");
  }
}

function pairCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";
  for (const byte of randomBytes(8)) value += alphabet[byte % alphabet.length];
  return `${value.slice(0, 4)}-${value.slice(4, 8)}`;
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
  <title>Glitchly Demo Hub</title>
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
      <h1>Glitchly Demo Hub</h1>
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

async function readJsonBody(request: IncomingMessage, maxBytes = maxJsonBodyBytes): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maxBytes) throw new Error("Request body too large.");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function readBinaryBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maxBytes) throw new Error("Request body too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
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

function numberFromSearchParam(url: URL, key: string, fallback: number, limits: { min: number; max: number }): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < limits.min || value > limits.max) {
    throw new Error(`${key} must be a number between ${limits.min} and ${limits.max}.`);
  }
  return Math.floor(value);
}

function numberFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
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

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

async function closeServers(servers: Server[]): Promise<void> {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
}

function printHelp(): void {
  console.log(`Glitchly

Usage:
  cartograph run <url> [--out .glitchly/runs/my-app] [--viewports desktop,mobile] [--max-actions 150] [--max-depth 6] [--quality-threshold 75] [--headed]
  cartograph view [run-dir] [--port 4173] [--host 127.0.0.1] [--no-open]
  cartograph connect --pair 8K4P-JD91 [--server https://glitchly-app.onrender.com]
  cartograph demo [--out .glitchly/runs/demo] [--no-open] [--no-view]
  cartograph export <run-dir> --format json|markdown [--include-quality]

Examples:
  cartograph view
  cartograph run http://localhost:3000 --out .glitchly/runs/my-app
  cartograph connect --pair 8K4P-JD91 --server https://glitchly-app.onrender.com
  cartograph export .glitchly/runs/my-app --format json
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

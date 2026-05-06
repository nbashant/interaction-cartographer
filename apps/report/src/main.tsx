import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  Bug,
  FileJson,
  FileText,
  Image,
  Info,
  Loader2,
  Monitor,
  MousePointerClick,
  Play,
  Route,
  Search,
  Smartphone,
  Square,
  Terminal
} from "lucide-react";
import type {
  BuildQualityCategoryId,
  BuildQualityRisk,
  BuildQualityScoreboard,
  CartographRun,
  FindingSeverity,
  UIFinding,
  ScanProgressSnapshot,
  UIState,
  UITransition,
  ViewportName
} from "@interaction-cartographer/core";
import "./styles.css";

type FilterSeverity = FindingSeverity | "all";
type ViewportFilter = ViewportName | "all";
type ArtifactTab = "states" | "transitions" | "actions";
type ReportView = "findings" | "quality";
type QualityFilter = BuildQualityCategoryId | "all";
type AgentSession = {
  sessionId: string;
  pairCode: string;
  expiresAt: string;
  status: "waiting" | "connected" | "disconnected" | "expired";
  connected: boolean;
  agentName?: string;
  lastSeenAt?: string;
  progress?: ScanProgressSnapshot;
};
type ScanPreferences = {
  viewports: string;
  allowSubmit: boolean;
  allowExternal: boolean;
};

const severityOrder: Record<FindingSeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1
};
const scanPreferencesStorageKey = "glitchly.scanPreferences.v1";
const targetUrlStorageKey = "glitchly.targetUrl.v1";
const agentSessionStorageKey = "glitchly.agentSession.v1";
const scanLimits = {
  actions: { min: 1, max: 1000, recommended: 80, rangeLabel: "1-1000" },
  depth: { min: 0, max: 30, recommended: 6, rangeLabel: "0-30" }
};
const defaultScanPreferences: ScanPreferences = {
  viewports: "desktop,mobile",
  allowSubmit: true,
  allowExternal: false
};
const allowedViewportPreferences = new Set(["desktop,mobile", "desktop", "mobile"]);

function readScanPreferences(): ScanPreferences {
  try {
    const raw = window.localStorage.getItem(scanPreferencesStorageKey);
    if (!raw) return defaultScanPreferences;
    const parsed = JSON.parse(raw) as Partial<ScanPreferences>;
    return {
      viewports: typeof parsed.viewports === "string" && allowedViewportPreferences.has(parsed.viewports) ? parsed.viewports : defaultScanPreferences.viewports,
      allowSubmit: typeof parsed.allowSubmit === "boolean" ? parsed.allowSubmit : defaultScanPreferences.allowSubmit,
      allowExternal: typeof parsed.allowExternal === "boolean" ? parsed.allowExternal : defaultScanPreferences.allowExternal
    };
  } catch {
    return defaultScanPreferences;
  }
}

function writeScanPreferences(preferences: ScanPreferences): void {
  try {
    window.localStorage.setItem(scanPreferencesStorageKey, JSON.stringify(preferences));
  } catch {
    // Scan preferences are a convenience; scanning should still work if storage is unavailable.
  }
}

function readTargetUrl(): string {
  try {
    const value = window.localStorage.getItem(targetUrlStorageKey);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function writeTargetUrl(url: string): void {
  try {
    window.localStorage.setItem(targetUrlStorageKey, url);
  } catch {
    // The input should still work even if storage is unavailable.
  }
}

function isHostedUi(): boolean {
  return !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function readAgentSessionId(): string {
  try {
    return window.sessionStorage.getItem(agentSessionStorageKey) ?? "";
  } catch {
    return "";
  }
}

function writeAgentSessionId(sessionId: string): void {
  try {
    window.sessionStorage.setItem(agentSessionStorageKey, sessionId);
  } catch {
    // Pairing should still work without session storage; reload just creates a new code.
  }
}

function sessionQuery(sessionId?: string | null): string {
  return sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
}

function assetHref(assetPath: string, sessionId?: string | null): string {
  return `/${assetPath}${sessionQuery(sessionId)}`;
}

async function fetchRunData(sessionId?: string | null): Promise<CartographRun | null> {
  const response = await fetch(`/api/run${sessionQuery(sessionId)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load run data: ${response.status}`);
  return response.json() as Promise<CartographRun | null>;
}

async function fetchScanProgress(sessionId?: string | null): Promise<ScanProgressSnapshot | null> {
  const response = await fetch(`/api/scan/progress${sessionQuery(sessionId)}`, { cache: "no-store" });
  if (!response.ok) return null;
  return response.json() as Promise<ScanProgressSnapshot>;
}

async function createOrResumeAgentSession(sessionId?: string): Promise<AgentSession> {
  const response = await fetch("/api/agent/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId })
  });
  if (!response.ok) throw new Error(`Failed to create pairing session: ${response.status}`);
  return response.json() as Promise<AgentSession>;
}

async function fetchAgentSession(sessionId: string): Promise<AgentSession | null> {
  const response = await fetch(`/api/agent/session${sessionQuery(sessionId)}`, { cache: "no-store" });
  if (!response.ok) return null;
  return response.json() as Promise<AgentSession>;
}

function numberOrDefault(value: string, fallback: number): number {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : fallback;
}

function App() {
  const hostedUi = useMemo(() => isHostedUi(), []);
  const [run, setRun] = useState<CartographRun | null>(null);
  const [targetUrl, setTargetUrl] = useState(() => readTargetUrl());
  const [maxActions, setMaxActions] = useState("");
  const [maxDepth, setMaxDepth] = useState("");
  const [scanPreferences, setScanPreferences] = useState<ScanPreferences>(() => readScanPreferences());
  const scanPreferencesRef = useRef(scanPreferences);
  const [agentSession, setAgentSession] = useState<AgentSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgressSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<ViewportFilter>("all");
  const [severity, setSeverity] = useState<FilterSeverity>("all");
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [artifactTab, setArtifactTab] = useState<ArtifactTab>("states");
  const [activeView, setActiveView] = useState<ReportView>("findings");
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>("all");
  const { viewports, allowSubmit, allowExternal } = scanPreferences;
  const agentSessionId = hostedUi ? agentSession?.sessionId : undefined;
  const agentConnected = !hostedUi || agentSession?.connected === true;

  function applyRunData(data: CartographRun | null) {
    setRun(data);
    setSelectedFindingId(data?.findings[0]?.id ?? null);
  }

  function applyProgress(progress: ScanProgressSnapshot) {
    if (progress.active || progress.phase !== "idle") setScanProgress(progress);
    if (progress.targetUrl) {
      setTargetUrl(progress.targetUrl);
      writeTargetUrl(progress.targetUrl);
    }
    if (progress.active) {
      setScanning(true);
      setStopRequested(false);
      setError(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const loadInitialState = async () => {
      try {
        let session: AgentSession | null = null;
        if (hostedUi) {
          session = await createOrResumeAgentSession(readAgentSessionId());
          writeAgentSessionId(session.sessionId);
          if (!cancelled) setAgentSession(session);
        }
        const [runData, progress] = await Promise.all([fetchRunData(session?.sessionId), fetchScanProgress(session?.sessionId)]);
        if (cancelled) return;
        applyRunData(runData);
        if (progress) applyProgress(progress);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void loadInitialState();
    return () => {
      cancelled = true;
    };
  }, [hostedUi]);

  useEffect(() => {
    if (!hostedUi || !agentSession?.sessionId) return;
    let cancelled = false;
    const refreshAgent = async () => {
      const session = await fetchAgentSession(agentSession.sessionId).catch(() => null);
      if (cancelled || !session) return;
      setAgentSession(session);
      if (session.progress?.active || session.progress?.phase === "completed" || session.progress?.phase === "stopped" || session.progress?.phase === "error") {
        applyProgress(session.progress);
      }
    };
    const interval = window.setInterval(() => {
      void refreshAgent();
    }, 1500);
    void refreshAgent();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [hostedUi, agentSession?.sessionId]);

  function updateScanPreferences(nextPreferences: Partial<ScanPreferences>) {
    const updated = { ...scanPreferencesRef.current, ...nextPreferences };
    scanPreferencesRef.current = updated;
    setScanPreferences(updated);
    writeScanPreferences(updated);
  }

  useEffect(() => {
    if (!scanning && !stopRequested) return;
    let cancelled = false;
    const refreshProgress = async () => {
      try {
        const progress = await fetchScanProgress(agentSessionId);
        if (cancelled || !progress) return;
        if (progress.active || progress.phase !== "idle") setScanProgress(progress);
        if (progress.targetUrl) {
          setTargetUrl(progress.targetUrl);
          writeTargetUrl(progress.targetUrl);
        }
        if (!progress.active && progress.phase !== "idle") {
          if (progress.phase === "completed" || progress.phase === "stopped") {
            const latestRun = await fetchRunData(agentSessionId);
            if (!cancelled) applyRunData(latestRun);
          } else if (progress.phase === "error") {
            setError(progress.message);
          }
          if (!cancelled) {
            setScanning(false);
            setStopRequested(false);
          }
        }
      } catch {
        // Progress polling is best-effort; the scan request still owns success/failure.
      }
    };
    void refreshProgress();
    const interval = window.setInterval(() => {
      void refreshProgress();
    }, 600);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [scanning, stopRequested, agentSessionId]);

  const selectedFinding = useMemo(() => run?.findings.find((finding) => finding.id === selectedFindingId) ?? null, [run, selectedFindingId]);
  const selectedState = useMemo(() => run?.states.find((state) => state.id === selectedFinding?.stateId) ?? null, [run, selectedFinding]);
  const selectedTransition = useMemo(() => run?.transitions.find((transition) => transition.id === selectedFinding?.transitionId) ?? null, [run, selectedFinding]);
  const quality = useMemo(() => run?.quality ?? null, [run]);

  const visibleFindings = useMemo(() => {
    if (!run) return [];
    return run.findings
      .filter((finding) => severity === "all" || finding.severity === severity)
      .filter((finding) => viewport === "all" || run.states.find((state) => state.id === finding.stateId)?.viewport === viewport)
      .sort((a, b) => severityOrder[b.severity] - severityOrder[a.severity]);
  }, [run, severity, viewport]);

  async function scan(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const scanTarget = targetUrl.trim();
    if (hostedUi && !agentConnected) {
      setError("Connect the local companion before scanning a localhost app from the hosted UI.");
      return;
    }
    const actionsLimit = numberOrDefault(maxActions, scanLimits.actions.recommended);
    const depthLimit = numberOrDefault(maxDepth, scanLimits.depth.recommended);
    setScanning(true);
    setStopRequested(false);
    setError(null);
    if (scanTarget) {
      setTargetUrl(scanTarget);
      writeTargetUrl(scanTarget);
    }
    setScanProgress({
      active: true,
      phase: "starting",
      message: `Preparing scan for ${scanTarget || targetUrl}`,
      targetUrl: scanTarget || targetUrl,
      statesFound: 0,
      transitionsFound: 0,
      findingsFound: 0,
      actionsAttempted: 0,
      maxActions: actionsLimit,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      recentEvents: []
    });
    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: scanTarget,
          maxActions: actionsLimit,
          maxDepth: depthLimit,
          viewports,
          allowSubmit,
          allowExternal,
          sessionId: agentSessionId
        })
      });
      const data = (await response.json()) as { run?: CartographRun; progress?: ScanProgressSnapshot; queued?: boolean; error?: string; requiresAgent?: boolean };
      if (data.queued) {
        if (data.progress) setScanProgress(data.progress);
        return;
      }
      if (!response.ok || !data.run) {
        if (data.progress?.active) {
          applyProgress(data.progress);
          setError(data.error ?? `Scan failed: ${response.status}`);
          return;
        }
        throw new Error(data.error ?? `Scan failed: ${response.status}`);
      }
      applyRunData(data.run);
      writeTargetUrl(scanTarget || data.run.startUrl);
      if (data.progress) setScanProgress(data.progress);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : String(scanError));
    } finally {
      const progress = await fetchScanProgress(agentSessionId);
      if (progress?.active) {
        applyProgress(progress);
      } else {
        setScanning(false);
        setStopRequested(false);
      }
    }
  }

  async function stopScan() {
    setError(null);
    setStopRequested(true);
    try {
      const response = await fetch("/api/scan/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: agentSessionId })
      });
      const data = (await response.json()) as { stopped?: boolean; message?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? `Stop failed: ${response.status}`);
      if (data.stopped) {
        setStopRequested(true);
      } else {
        setStopRequested(false);
        setError(data.message ?? "No active scan is running.");
      }
    } catch (stopError) {
      setStopRequested(false);
      setError(stopError instanceof Error ? stopError.message : String(stopError));
    }
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand-block">
          <Route size={20} aria-hidden="true" />
          <div>
            <strong>Glitchly</strong>
            <span>{run ? run.startUrl : "real localhost scanner"}</span>
          </div>
        </div>
        <div className="view-tabs" role="tablist" aria-label="Report views">
          <button className={activeView === "findings" ? "is-selected" : ""} type="button" onClick={() => setActiveView("findings")} disabled={!run}>
            <Bug size={15} aria-hidden="true" />
            Findings
          </button>
          <button className={activeView === "quality" ? "is-selected" : ""} type="button" onClick={() => setActiveView("quality")} disabled={!quality}>
            <Terminal size={15} aria-hidden="true" />
            Build Quality
          </button>
        </div>
        <div className="top-actions">
          <ExportButton href={`/api/export/json${sessionQuery(agentSessionId)}`} label="JSON" icon={<FileJson size={15} />} disabled={!run || scanning} />
          <ExportButton href={`/api/export/markdown${sessionQuery(agentSessionId)}`} label="Markdown" icon={<FileText size={15} />} disabled={!run || scanning} />
        </div>
      </header>

      <main className="scanner-shell">
        <section className="scan-panel">
          <form className="scan-form" onSubmit={scan}>
            <label className="url-field">
              <span>Local app URL</span>
              <input value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} placeholder="http://localhost:3000" />
            </label>
            <BoundedNumberField
              id="scan-max-actions"
              label="Actions"
              value={maxActions}
              onChange={setMaxActions}
              min={scanLimits.actions.min}
              max={scanLimits.actions.max}
              rangeLabel={scanLimits.actions.rangeLabel}
              tooltipId="scan-limit-tooltip-actions"
              showHelp
            />
            <BoundedNumberField
              id="scan-max-depth"
              label="Depth"
              value={maxDepth}
              onChange={setMaxDepth}
              min={scanLimits.depth.min}
              max={scanLimits.depth.max}
              rangeLabel={scanLimits.depth.rangeLabel}
              tooltipId="scan-limit-tooltip-depth"
            />
            <label>
              <span>Viewports</span>
              <select value={viewports} onChange={(event) => updateScanPreferences({ viewports: event.target.value })}>
                <option value="desktop,mobile">Desktop + mobile</option>
                <option value="desktop">Desktop</option>
                <option value="mobile">Mobile</option>
              </select>
            </label>
            <label className="toggle-row">
              <input type="checkbox" checked={allowSubmit} onChange={(event) => updateScanPreferences({ allowSubmit: event.target.checked })} />
              Allow local submits
            </label>
            <label className="toggle-row">
              <input type="checkbox" checked={allowExternal} onChange={(event) => updateScanPreferences({ allowExternal: event.target.checked })} />
              Allow external links
            </label>
            <div className="scan-actions">
              <button className="primary-button scan-button" type="submit" disabled={scanning || !agentConnected}>
                {scanning ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Search size={15} aria-hidden="true" />}
                {scanning ? "Scanning" : "Scan real app"}
              </button>
              {scanning ? (
                <button className="danger-button stop-button" type="button" onClick={stopScan} disabled={stopRequested}>
                  <Square size={14} aria-hidden="true" />
                  {stopRequested ? "Stopping" : "Stop"}
                </button>
              ) : null}
            </div>
          </form>
          {hostedUi && agentSession ? <LocalCompanionPanel session={agentSession} /> : null}
          {error ? <div className="inline-error"><AlertTriangle size={15} /> {error}</div> : null}
          {scanning || stopRequested ? <ScanActivityPanel progress={scanProgress} /> : null}
        </section>

        {loading ? <ShellLoading /> : null}
        {!loading && !run ? <EmptyScanner scanning={scanning} stopRequested={stopRequested} /> : null}
        {run?.summary.status === "stopped" ? (
          <div className="status-banner">
            <Square size={15} aria-hidden="true" />
            Stopped scan: partial results shown.
          </div>
        ) : null}
        {run && activeView === "quality" && quality ? (
          <QualityScoreboard
            quality={quality}
            exportHref={`/api/export/markdown${sessionQuery(agentSessionId)}`}
            activeCategory={qualityFilter}
            setActiveCategory={setQualityFilter}
            onOpenRisk={(risk) => {
              const findingId = risk.findingIds.find((id) => run.findings.some((finding) => finding.id === id));
              const state = run.states.find((item) => item.id === risk.stateIds[0]);
              setSelectedFindingId(findingId ?? null);
              if (state) setViewport(state.viewport);
              setArtifactTab(findingId ? "transitions" : "states");
              setActiveView("findings");
            }}
          />
        ) : null}
        {run && activeView === "findings" ? (
          <section className="findings-workbench" aria-busy={scanning}>
            <aside className="findings-column">
              <RunSummaryBar run={run} />
              <Filters
                severity={severity}
                viewport={viewport}
                setSeverity={setSeverity}
                setViewport={setViewport}
                count={visibleFindings.length}
              />
              <FindingsList
                findings={visibleFindings}
                states={run.states}
                selectedFindingId={selectedFinding?.id ?? null}
                onSelect={(finding) => setSelectedFindingId(finding.id)}
              />
            </aside>
            <section className="evidence-column">
              <FindingDetail finding={selectedFinding} state={selectedState} transition={selectedTransition} assetSessionId={agentSessionId} />
              <ArtifactExplorer run={run} activeTab={artifactTab} setActiveTab={setArtifactTab} />
            </section>
          </section>
        ) : null}
      </main>
    </div>
  );
}

function ExportButton({ href, label, icon, disabled }: { href: string; label: string; icon: React.ReactNode; disabled: boolean }) {
  return (
    <button className="ghost-button" type="button" disabled={disabled} onClick={() => (window.location.href = href)}>
      {icon}
      Export {label}
    </button>
  );
}

const defaultHostedOrigin = "https://glitchly.onrender.com";

function LocalCompanionPanel({ session }: { session: AgentSession }) {
  const command =
    window.location.origin === defaultHostedOrigin
      ? `npx -y @interaction-cartographer/cli@latest connect --pair ${session.pairCode}`
      : `npx -y @interaction-cartographer/cli@latest connect --pair ${session.pairCode} --server ${window.location.origin}`;
  const connected = session.connected;
  async function copyCommand() {
    await navigator.clipboard?.writeText(command).catch(() => undefined);
  }

  return (
    <section className={`companion-panel ${connected ? "is-connected" : ""}`} aria-label="Local companion">
      <div className="companion-status">
        <span className="status-dot" aria-hidden="true" />
        <div>
          <strong>{connected ? "Local companion connected" : "Connect local companion"}</strong>
          <span>{connected ? session.agentName ?? "Ready to scan localhost from your machine" : "Run this once in the app's local terminal."}</span>
        </div>
      </div>
      <code>{command}</code>
      <button className="ghost-button" type="button" onClick={copyCommand}>
        <FileText size={14} aria-hidden="true" />
        Copy
      </button>
    </section>
  );
}

function BoundedNumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  rangeLabel,
  tooltipId,
  showHelp = false
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  rangeLabel: string;
  tooltipId: string;
  showHelp?: boolean;
}) {
  return (
    <div className="scan-field">
      <div className="field-label-row">
        <label htmlFor={id}>{label}</label>
        {showHelp ? <ScanLimitsHelp tooltipId={tooltipId} /> : null}
      </div>
      <div className="number-input-shell">
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          inputMode="numeric"
          type="number"
          min={min}
          max={max}
          step={1}
          placeholder={rangeLabel}
        />
      </div>
    </div>
  );
}

function ScanLimitsHelp({ tooltipId }: { tooltipId: string }) {
  return (
    <span className="scan-limit-help">
      <button className="scan-limit-trigger" type="button" aria-label="Scan limit guidance" aria-describedby={tooltipId}>
        <Info size={12} aria-hidden="true" />
      </button>
      <span className="scan-limit-tooltip" id={tooltipId} role="tooltip">
        <span className="tooltip-copy">
          <strong>Actions</strong>
          <span>Maximum UI interactions attempted per viewport.</span>
        </span>
        <span className="tooltip-copy">
          <strong>Depth</strong>
          <span>Maximum interaction chain length from the starting page.</span>
        </span>
        <span className="tooltip-recommended">
          <span>Recommended</span>
          <strong>Actions {scanLimits.actions.recommended}</strong>
          <strong>Depth {scanLimits.depth.recommended}</strong>
        </span>
      </span>
    </span>
  );
}

function ScanActivityPanel({ progress }: { progress: ScanProgressSnapshot | null }) {
  const current = progress ?? {
    active: true,
    phase: "starting" as const,
    message: "Preparing scan",
    statesFound: 0,
    transitionsFound: 0,
    findingsFound: 0,
    actionsAttempted: 0,
    maxActions: 0,
    recentEvents: []
  };
  const actionCounter = current.maxActions > 0 ? `${current.actionsAttempted} / ${current.maxActions}` : String(current.actionsAttempted);

  return (
    <section className="scan-activity" aria-live="polite" aria-label="Live scan activity">
      <div className="scan-activity-heading">
        <div>
          <span>Live scan activity</span>
          <strong>{phaseLabel(current.phase)}</strong>
        </div>
        <Activity size={18} aria-hidden="true" />
      </div>
      <div className="activity-meter" aria-hidden="true">
        <span />
      </div>
      <div className="activity-status">
        <strong>{current.message}</strong>
        <span>{current.currentAction ? `Current action: ${current.currentAction}` : current.currentUrl ?? current.targetUrl ?? "Preparing browser"}</span>
      </div>
      <div className="activity-counters" aria-label="Scan counters">
        <div>
          <span>States</span>
          <strong>{current.statesFound}</strong>
        </div>
        <div>
          <span>Actions</span>
          <strong>{actionCounter}</strong>
        </div>
        <div>
          <span>Findings</span>
          <strong>{current.findingsFound}</strong>
        </div>
      </div>
      <div className="activity-feed">
        {current.recentEvents.length ? (
          current.recentEvents.slice(0, 4).map((event) => (
            <p key={event.id}>
              <span>{phaseLabel(event.phase)}</span>
              {event.message}
            </p>
          ))
        ) : (
          <p>
            <span>Starting</span>
            Waiting for the browser worker to report its first captured state.
          </p>
        )}
      </div>
    </section>
  );
}

function phaseLabel(phase: ScanProgressSnapshot["phase"]): string {
  if (phase === "opening") return "Opening app";
  if (phase === "capturing") return "Capturing evidence";
  if (phase === "testing") return "Testing actions";
  if (phase === "writing") return "Writing report";
  if (phase === "completed") return "Complete";
  if (phase === "stopped") return "Stopped";
  if (phase === "error") return "Error";
  if (phase === "idle") return "Idle";
  return "Starting";
}

function RunSummaryBar({ run }: { run: CartographRun }) {
  return (
    <section className="summary-strip" aria-label="Run summary">
      <SummaryChip icon={<Bug size={16} />} label="Findings" value={run.summary.findingCount} />
      <SummaryChip icon={<Image size={16} />} label="States" value={run.summary.stateCount} />
      <SummaryChip icon={<MousePointerClick size={16} />} label="Transitions" value={run.summary.transitionCount} />
      <SummaryChip icon={<Terminal size={16} />} label="Actions" value={run.summary.actionsAttempted} />
    </section>
  );
}

function SummaryChip({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="summary-chip">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function QualityScoreboard({
  quality,
  exportHref,
  activeCategory,
  setActiveCategory,
  onOpenRisk
}: {
  quality: BuildQualityScoreboard;
  exportHref: string;
  activeCategory: QualityFilter;
  setActiveCategory: (category: QualityFilter) => void;
  onOpenRisk: (risk: BuildQualityRisk) => void;
}) {
  const visibleRisks = quality.topRisks.filter((risk) => activeCategory === "all" || risk.categoryId === activeCategory);
  const activeLabel = activeCategory === "all" ? "All categories" : quality.categories.find((category) => category.id === activeCategory)?.label ?? "Selected category";

  return (
    <section className="quality-workbench" aria-label="Build Quality Scoreboard">
      <section className="panel quality-hero">
        <div className="quality-score" style={{ "--score": quality.overallScore } as React.CSSProperties}>
          <span>Build Quality Score</span>
          <strong>{quality.overallScore}</strong>
          <em>/ 100</em>
        </div>
        <div className="quality-status">
          <span>Status</span>
          <strong>{formatQualityStatus(quality.status)}</strong>
          <p>Crawl-backed readiness signal from findings, screenshots, reachable states, transitions, and run metadata.</p>
        </div>
      </section>

      <section className="quality-categories" aria-label="Build quality categories">
        {quality.categories.map((category) => (
          <button
            key={category.id}
            className={`quality-category ${activeCategory === category.id ? "is-selected" : ""}`}
            type="button"
            onClick={() => setActiveCategory(activeCategory === category.id ? "all" : category.id)}
          >
            <span>{category.label}</span>
            <strong>{category.score}</strong>
            <div className="score-track" aria-hidden="true">
              <i style={{ width: `${category.score}%` }} />
            </div>
            <p>{category.summary}</p>
          </button>
        ))}
      </section>

      <section className="panel quality-risks">
        <div className="quality-section-heading">
          <div>
            <span>Top Risks</span>
            <strong>{activeLabel}</strong>
          </div>
          {activeCategory !== "all" ? (
            <button className="ghost-button" type="button" onClick={() => setActiveCategory("all")}>
              Show all
            </button>
          ) : null}
        </div>
        <div className="risk-list">
          {visibleRisks.map((risk, index) => (
            <button key={risk.id} className={`risk-row severity-${risk.severity}`} type="button" onClick={() => onOpenRisk(risk)}>
              <em>{index + 1}</em>
              <span>
                <strong>{risk.title}</strong>
                <small>{riskLabel(risk, quality)}</small>
              </span>
            </button>
          ))}
          {visibleRisks.length === 0 ? <p className="empty-copy">No risks are currently attached to this category.</p> : null}
        </div>
      </section>

      <section className="panel quality-details">
        <details>
          <summary>Why this score?</summary>
          <p>{quality.formula.description}</p>
          <div className="formula-grid">
            {quality.categories.map((category) => (
              <div key={category.id}>
                <span>{category.label}</span>
                <strong>{Math.round(category.weight * 100)}%</strong>
              </div>
            ))}
          </div>
        </details>
        <div className="strength-list">
          <strong>Strengths</strong>
          {quality.strengths.map((strength) => (
            <p key={strength.id}>{strength.title}: {strength.detail}</p>
          ))}
          {quality.strengths.length === 0 ? <p>No category cleared the strength threshold on this crawl.</p> : null}
        </div>
        <div className="quality-export">
          <strong>Markdown export</strong>
          <p>The Markdown findings export includes this scorecard, top risks, and formula.</p>
          <button className="ghost-button" type="button" onClick={() => (window.location.href = exportHref)}>
            <FileText size={15} aria-hidden="true" />
            Export Markdown
          </button>
        </div>
      </section>
    </section>
  );
}

function riskLabel(risk: BuildQualityRisk, quality: BuildQualityScoreboard): string {
  const category = quality.categories.find((item) => item.id === risk.categoryId);
  const findingCount = risk.findingIds.length;
  const stateCount = risk.stateIds.length;
  return `${category?.label ?? "Build Quality"} · ${risk.severity} · ${findingCount ? `${findingCount} finding(s)` : "run metadata"} · ${stateCount} state(s)`;
}

function formatQualityStatus(status: BuildQualityScoreboard["status"]): string {
  if (status === "looks_strong") return "Looks strong";
  if (status === "shareable_minor_issues") return "Shareable with minor issues";
  if (status === "needs_polish") return "Needs polish";
  if (status === "risky_build") return "Risky build";
  return "Not ready";
}

function Filters({
  severity,
  viewport,
  setSeverity,
  setViewport,
  count
}: {
  severity: FilterSeverity;
  viewport: ViewportFilter;
  setSeverity: (value: FilterSeverity) => void;
  setViewport: (value: ViewportFilter) => void;
  count: number;
}) {
  return (
    <div className="filter-bar">
      <strong>{count} visible findings</strong>
      <select aria-label="Severity filter" value={severity} onChange={(event) => setSeverity(event.target.value as FilterSeverity)}>
        <option value="all">All severities</option>
        <option value="critical">Critical</option>
        <option value="warning">Warning</option>
        <option value="info">Info</option>
      </select>
      <Segmented
        value={viewport}
        options={[
          { value: "all", label: "All" },
          { value: "desktop", label: "Desktop", icon: <Monitor size={14} /> },
          { value: "mobile", label: "Mobile", icon: <Smartphone size={14} /> }
        ]}
        onChange={(value) => setViewport(value as ViewportFilter)}
        ariaLabel="Viewport filter"
      />
    </div>
  );
}

function FindingsList({
  findings,
  states,
  selectedFindingId,
  onSelect
}: {
  findings: UIFinding[];
  states: UIState[];
  selectedFindingId: string | null;
  onSelect: (finding: UIFinding) => void;
}) {
  return (
    <section className="panel findings-panel" aria-label="Findings">
      {findings.map((finding) => {
        const state = states.find((item) => item.id === finding.stateId);
        return (
          <button
            key={finding.id}
            className={`finding-row severity-${finding.severity} ${selectedFindingId === finding.id ? "is-selected" : ""}`}
            type="button"
            onClick={() => onSelect(finding)}
          >
            <span className="finding-icon">{finding.severity === "critical" ? <AlertTriangle size={16} /> : <Bug size={16} />}</span>
            <span>
              <strong>{finding.title}</strong>
              <small>{finding.detector} · {state?.label ?? finding.stateId} · {state?.viewport ?? "unknown"}</small>
            </span>
            <em>{finding.replayPath.length}</em>
          </button>
        );
      })}
      {findings.length === 0 ? <p className="empty-copy">No findings match the current filters.</p> : null}
    </section>
  );
}

function FindingDetail({
  finding,
  state,
  transition,
  assetSessionId
}: {
  finding: UIFinding | null;
  state: UIState | null;
  transition: UITransition | null;
  assetSessionId?: string | null;
}) {
  if (!finding || !state) {
    return (
      <section className="panel finding-detail">
        <p className="empty-copy">Select a finding to inspect screenshot evidence, replay steps, DOM signals, and action context.</p>
      </section>
    );
  }

  return (
    <section className="panel finding-detail" aria-label="Finding detail">
      <div className="detail-heading">
        <div>
          <span className={`severity-pill severity-${finding.severity}`}>{finding.severity}</span>
          <h1>{finding.title}</h1>
          <p>{finding.detector} · {state.viewport} · {state.url}</p>
        </div>
        <a className="ghost-link" href={assetHref(finding.screenshotPath, assetSessionId)} target="_blank" rel="noreferrer">
          Open screenshot
        </a>
      </div>

      <div className="evidence-layout">
        <div className="screenshot-frame">
          <img src={assetHref(finding.screenshotPath, assetSessionId)} alt={`Screenshot for ${finding.title}`} />
        </div>
        <div className="evidence-stack">
          <DetailItem label="Detail" value={finding.detail} />
          <DetailItem label="State" value={`${state.id} · ${state.label}`} />
          <DetailItem label="Selector" value={finding.selector ?? "n/a"} />
          <DetailItem label="Action" value={transition?.action.label ?? "state-level finding"} />
          <DetailItem label="Transition status" value={transition?.status ?? "n/a"} />
          <DetailItem label="DOM signals" value={`${state.domSummary.metrics.elementCount} elements, ${state.interactiveCount} controls`} />
        </div>
      </div>

      <div className="subgrid">
        <section>
          <h2>Evidence</h2>
          <div className="evidence-list">
            {finding.evidence.map((item) => (
              <DetailItem key={`${item.label}-${item.value}`} label={item.label} value={item.value} />
            ))}
          </div>
        </section>
        <section>
          <h2>Replay path</h2>
          <ol className="replay-steps">
            {finding.replayPath.map((step, index) => (
              <li key={`${step.type}-${step.selector ?? step.url}-${index}`}>
                <span>{index + 1}</span>
                <p>{describeReplayStep(step)}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </section>
  );
}

function ArtifactExplorer({
  run,
  activeTab,
  setActiveTab
}: {
  run: CartographRun;
  activeTab: ArtifactTab;
  setActiveTab: (tab: ArtifactTab) => void;
}) {
  const actions = useMemo(() => {
    const seen = new Set<string>();
    return run.transitions
      .map((transition) => transition.action)
      .filter((action) => {
        const key = `${action.type}:${action.selector}:${action.label ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [run.transitions]);

  return (
    <section className="panel artifact-explorer" aria-label="Extracted crawl details">
      <div className="artifact-tabs">
        <button className={activeTab === "states" ? "is-selected" : ""} type="button" onClick={() => setActiveTab("states")}>
          States
        </button>
        <button className={activeTab === "transitions" ? "is-selected" : ""} type="button" onClick={() => setActiveTab("transitions")}>
          Transitions
        </button>
        <button className={activeTab === "actions" ? "is-selected" : ""} type="button" onClick={() => setActiveTab("actions")}>
          Actions
        </button>
      </div>
      <div className="artifact-table">
        {activeTab === "states"
          ? run.states.map((state) => (
              <div className="artifact-row" key={state.id}>
                <strong>{state.id} · {state.label}</strong>
                <span>{state.viewport} · {state.interactiveCount} controls · {state.url}</span>
              </div>
            ))
          : null}
        {activeTab === "transitions"
          ? run.transitions.map((transition) => (
              <div className="artifact-row" key={transition.id}>
                <strong>{transition.fromStateId} {"->"} {transition.toStateId} · {transition.status}</strong>
                <span>{transition.action.type} · {transition.action.label ?? transition.action.selector}</span>
              </div>
            ))
          : null}
        {activeTab === "actions"
          ? actions.map((action) => (
              <div className="artifact-row" key={`${action.type}-${action.selector}-${action.label}`}>
                <strong>{action.type} · {action.label ?? action.selector}</strong>
                <span>{action.risk} · {action.selector}</span>
              </div>
            ))
          : null}
      </div>
    </section>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
  ariaLabel
}: {
  value: string;
  options: Array<{ value: string; label: string; icon?: React.ReactNode }>;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "is-selected" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

function EmptyScanner({ scanning, stopRequested }: { scanning: boolean; stopRequested: boolean }) {
  return (
    <section className="empty-scanner">
      {scanning ? <Loader2 size={28} className="spin" /> : <Search size={28} />}
      <strong>{stopRequested ? "Stopping scan and writing partial artifacts" : scanning ? "Scanning the local app" : "Enter a localhost URL to scan a real product"}</strong>
      <p>The crawl will write screenshots, states, transitions, actions, findings, replay paths, and export files into a local run folder.</p>
    </section>
  );
}

function ShellLoading() {
  return (
    <section className="empty-scanner">
      <Loader2 size={28} className="spin" />
      <strong>Loading run data</strong>
    </section>
  );
}

function describeReplayStep(step: UIFinding["replayPath"][number]): string {
  if (step.type === "goto") return `Go to ${step.url}`;
  if (step.type === "fill") return `Fill ${step.label ?? step.selector} with "${step.value}"`;
  if (step.type === "select") return `Select ${step.value || "first option"} in ${step.label ?? step.selector}`;
  if (step.type === "press") return `Press ${step.key ?? "Enter"} on ${step.label ?? step.selector}`;
  if (step.type === "wait") return `Wait ${step.timeoutMs ?? 250}ms`;
  return `Click ${step.label ?? step.selector}`;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

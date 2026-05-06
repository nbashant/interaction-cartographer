export type ViewportName = "desktop" | "mobile";

export interface ViewportConfig {
  name: ViewportName;
  width: number;
  height: number;
}

export interface CrawlOptions {
  maxActions: number;
  maxDepth: number;
  maxDurationMs: number;
  viewports: ViewportConfig[];
  allowExternal: boolean;
  allowSubmit: boolean;
  sameOriginOnly: boolean;
  denyActionLabels: string[];
  allowActionLabels: string[];
  outputDir: string;
  headed: boolean;
}

export type ScanProgressPhase = "idle" | "starting" | "opening" | "capturing" | "testing" | "writing" | "completed" | "stopped" | "error";

export interface ScanProgressEvent {
  id: string;
  timestamp: string;
  phase: ScanProgressPhase;
  message: string;
  targetUrl: string;
  viewport?: ViewportName;
  currentUrl?: string;
  currentAction?: string;
  statesFound: number;
  transitionsFound: number;
  findingsFound: number;
  actionsAttempted: number;
  maxActions: number;
}

export interface ScanProgressSnapshot {
  active: boolean;
  phase: ScanProgressPhase;
  message: string;
  targetUrl?: string;
  viewport?: ViewportName;
  currentUrl?: string;
  currentAction?: string;
  statesFound: number;
  transitionsFound: number;
  findingsFound: number;
  actionsAttempted: number;
  maxActions: number;
  startedAt?: string;
  updatedAt?: string;
  recentEvents: ScanProgressEvent[];
}

export type ScanProgressReporter = (event: ScanProgressEvent) => void;

export interface RunSummary {
  id: string;
  startUrl: string;
  createdAt: string;
  status?: "completed" | "stopped";
  durationMs: number;
  stateCount: number;
  transitionCount: number;
  findingCount: number;
  actionsAttempted: number;
  viewports: ViewportName[];
  issuesBySeverity: Record<FindingSeverity, number>;
}

export interface CartographRun {
  id: string;
  startUrl: string;
  createdAt: string;
  options: CrawlOptions;
  summary: RunSummary;
  quality?: BuildQualityScoreboard;
  states: UIState[];
  transitions: UITransition[];
  findings: UIFinding[];
  assets: RunAsset[];
}

export interface RunAsset {
  id: string;
  type: "screenshot" | "replay" | "report";
  path: string;
  stateId?: string;
  findingId?: string;
}

export interface StateFingerprint {
  urlKey: string;
  textHash: string;
  domHash: string;
  roleHash: string;
  visualHash: string;
  viewportKey: ViewportName;
  overlayKey?: string;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CandidateAction {
  id: string;
  stateId: string;
  type: "click" | "fill" | "select" | "press" | "hover";
  selector: string;
  role?: string;
  label?: string;
  text?: string;
  href?: string;
  boundingBox?: Box;
  risk: "safe" | "caution" | "blocked";
  reason: string;
  score: number;
}

export interface UITransition {
  id: string;
  fromStateId: string;
  toStateId: string;
  actionId: string;
  action: CandidateAction;
  durationMs: number;
  status: "changed" | "no_effect" | "error" | "blocked";
  screenshotBeforePath: string;
  screenshotAfterPath: string;
}

export type FindingSeverity = "info" | "warning" | "critical";

export interface FindingEvidence {
  label: string;
  value: string;
}

export interface UIFinding {
  id: string;
  severity: FindingSeverity;
  detector: string;
  title: string;
  detail: string;
  stateId: string;
  transitionId?: string;
  actionId?: string;
  selector?: string;
  screenshotPath: string;
  evidence: FindingEvidence[];
  replayPath: ReplayStep[];
}

export interface ReplayStep {
  type: "goto" | "click" | "fill" | "select" | "press" | "wait";
  url?: string;
  selector?: string;
  value?: string;
  key?: string;
  timeoutMs?: number;
  label?: string;
}

export type BuildQualityCategoryId =
  | "interaction_health"
  | "responsive_health"
  | "error_health"
  | "accessibility_smoke"
  | "state_coverage"
  | "visual_stability";

export type BuildQualityStatus = "looks_strong" | "shareable_minor_issues" | "needs_polish" | "risky_build" | "not_ready";

export interface ScoreFormula {
  weights: Record<BuildQualityCategoryId, number>;
  severityPenalty: Record<FindingSeverity, number>;
  repeatedFindingPenaltyMultiplier: number;
  description: string;
}

export interface BuildQualityCategoryScore {
  id: BuildQualityCategoryId;
  label: string;
  score: number;
  weight: number;
  summary: string;
  evidenceFindingIds: string[];
  evidenceStateIds: string[];
}

export interface BuildQualityRisk {
  id: string;
  title: string;
  severity: FindingSeverity;
  categoryId: BuildQualityCategoryId;
  findingIds: string[];
  stateIds: string[];
  replayPath?: ReplayStep[];
}

export interface BuildQualityStrength {
  id: string;
  title: string;
  detail: string;
  categoryId: BuildQualityCategoryId;
}

export interface BuildQualityScoreboard {
  overallScore: number;
  status: BuildQualityStatus;
  categories: BuildQualityCategoryScore[];
  topRisks: BuildQualityRisk[];
  strengths: BuildQualityStrength[];
  formula: ScoreFormula;
  generatedAt: string;
}

export interface ConsoleEvent {
  type: string;
  text: string;
  location?: string;
  timestamp: string;
}

export interface NetworkEvent {
  method: string;
  url: string;
  status?: number;
  failureText?: string;
  timestamp: string;
}

export interface FormSummary {
  selector: string;
  label: string;
  inputCount: number;
  submitCount: number;
}

export interface ElementSummary {
  selector: string;
  label: string;
  role?: string;
  tagName: string;
  box?: Box;
  disabled?: boolean;
}

export interface PageMetrics {
  elementCount: number;
  visibleTextLength: number;
  scrollWidth: number;
  clientWidth: number;
  overflowX: number;
  duplicateIdCount: number;
  unnamedButtonCount: number;
  unlabeledInputCount: number;
  offscreenInteractiveCount: number;
  textOverflowCount: number;
  mainBlank: boolean;
  disabledSubmitLikeCount: number;
}

export interface DomSummary {
  headings: string[];
  visibleTextSample: string[];
  roles: Record<string, number>;
  forms: FormSummary[];
  buttons: ElementSummary[];
  links: ElementSummary[];
  inputs: ElementSummary[];
  dialogs: ElementSummary[];
  metrics: PageMetrics;
}

export interface UIState {
  id: string;
  viewport: ViewportName;
  url: string;
  title?: string;
  label: string;
  fingerprint: StateFingerprint;
  screenshotPath: string;
  domSummary: DomSummary;
  interactiveCount: number;
  consoleErrors: ConsoleEvent[];
  networkErrors: NetworkEvent[];
  firstSeenAtActionId?: string;
  replayPath: ReplayStep[];
}

export interface DetectorInput {
  before?: UIState;
  after: UIState;
  transition?: UITransition;
  options: CrawlOptions;
}

export interface Detector {
  id: string;
  name: string;
  run(input: DetectorInput): Promise<UIFinding[]> | UIFinding[];
}

export interface ActionQueueItem {
  action: CandidateAction;
  fromStateId: string;
  replayPath: ReplayStep[];
  depth: number;
}

export const DEFAULT_VIEWPORTS: ViewportConfig[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 }
];

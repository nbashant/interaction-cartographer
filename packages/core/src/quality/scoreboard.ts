import type {
  BuildQualityCategoryId,
  BuildQualityCategoryScore,
  BuildQualityRisk,
  BuildQualityScoreboard,
  BuildQualityStatus,
  BuildQualityStrength,
  CartographRun,
  FindingSeverity,
  ScoreFormula,
  UIFinding,
  UIState
} from "../types.js";

type CategoryDefinition = {
  id: BuildQualityCategoryId;
  label: string;
  weight: number;
};

type MutableCategorySignals = {
  penalty: number;
  evidenceFindingIds: Set<string>;
  evidenceStateIds: Set<string>;
};

type FindingGroup = {
  key: string;
  first: UIFinding;
  severity: FindingSeverity;
  findingIds: string[];
  stateIds: string[];
  categoryIds: BuildQualityCategoryId[];
  penalty: number;
};

const categoryDefinitions: CategoryDefinition[] = [
  { id: "interaction_health", label: "Interaction Health", weight: 0.25 },
  { id: "responsive_health", label: "Responsive Health", weight: 0.2 },
  { id: "error_health", label: "Error Health", weight: 0.2 },
  { id: "accessibility_smoke", label: "Accessibility Smoke", weight: 0.15 },
  { id: "state_coverage", label: "State Coverage", weight: 0.1 },
  { id: "visual_stability", label: "Visual Stability", weight: 0.1 }
];

const detectorScoreMap: Record<string, BuildQualityCategoryId[]> = {
  "no-effect-click": ["interaction_health"],
  "modal-cannot-close": ["interaction_health"],
  "form-dead-end": ["interaction_health"],
  "navigation-loop": ["interaction_health"],
  "console-error": ["error_health"],
  "network-error": ["error_health"],
  "blank-render": ["error_health", "visual_stability"],
  "horizontal-overflow": ["responsive_health", "visual_stability"],
  "offscreen-interactive": ["responsive_health", "visual_stability"],
  "text-overlap": ["visual_stability"],
  "text-overlap-candidate": ["visual_stability"],
  "a11y-missing-name": ["accessibility_smoke"],
  "duplicate-id": ["accessibility_smoke"],
  "accessibility-smoke": ["accessibility_smoke"],
  "mobile-only-breakage": ["responsive_health"]
};

export const buildQualityFormula: ScoreFormula = {
  weights: Object.fromEntries(categoryDefinitions.map((category) => [category.id, category.weight])) as Record<BuildQualityCategoryId, number>,
  severityPenalty: {
    critical: 18,
    warning: 8,
    info: 3
  },
  repeatedFindingPenaltyMultiplier: 0.35,
  description:
    "overall = interaction_health * 0.25 + responsive_health * 0.20 + error_health * 0.20 + accessibility_smoke * 0.15 + state_coverage * 0.10 + visual_stability * 0.10"
};

export function generateBuildQualityScoreboard(run: CartographRun, generatedAt = new Date().toISOString()): BuildQualityScoreboard {
  const stateById = new Map(run.states.map((state) => [state.id, state]));
  const categorySignals = new Map<BuildQualityCategoryId, MutableCategorySignals>(
    categoryDefinitions.map((category) => [
      category.id,
      {
        penalty: 0,
        evidenceFindingIds: new Set<string>(),
        evidenceStateIds: new Set<string>()
      }
    ])
  );

  const groups = groupFindings(run, stateById);
  for (const group of groups) {
    for (const categoryId of group.categoryIds) {
      const signal = categorySignals.get(categoryId);
      if (!signal) continue;
      signal.penalty += group.penalty;
      for (const findingId of group.findingIds) signal.evidenceFindingIds.add(findingId);
      for (const stateId of group.stateIds) signal.evidenceStateIds.add(stateId);
    }
  }

  addInteractionSignals(run, categorySignals);
  addResponsiveSignals(run, categorySignals);
  addAccessibilitySignals(run, categorySignals);
  addVisualSignals(run, categorySignals);

  const coverage = stateCoverageScore(run);
  const categories = categoryDefinitions.map((definition) => {
    const signal = categorySignals.get(definition.id);
    const score = definition.id === "state_coverage" ? coverage.score : clampScore(100 - (signal?.penalty ?? 0));
    const evidenceStateIds = definition.id === "state_coverage" ? coverage.evidenceStateIds : Array.from(signal?.evidenceStateIds ?? []);
    return {
      id: definition.id,
      label: definition.label,
      score,
      weight: definition.weight,
      summary: categorySummary(definition.id, score, run, groups, coverage.summary),
      evidenceFindingIds: Array.from(signal?.evidenceFindingIds ?? []),
      evidenceStateIds
    };
  });

  const overallScore = clampScore(
    categories.reduce((sum, category) => sum + category.score * category.weight, 0)
  );
  const topRisks = topRisksForRun(run, groups, coverage);

  return {
    overallScore,
    status: statusForScore(overallScore),
    categories,
    topRisks,
    strengths: strengthsForCategories(categories),
    formula: buildQualityFormula,
    generatedAt
  };
}

export function formatBuildQualityStatus(status: BuildQualityStatus): string {
  if (status === "looks_strong") return "Looks strong";
  if (status === "shareable_minor_issues") return "Shareable with minor issues";
  if (status === "needs_polish") return "Needs polish";
  if (status === "risky_build") return "Risky build";
  return "Not ready";
}

export function statusForScore(score: number): BuildQualityStatus {
  if (score >= 90) return "looks_strong";
  if (score >= 75) return "shareable_minor_issues";
  if (score >= 60) return "needs_polish";
  if (score >= 40) return "risky_build";
  return "not_ready";
}

function groupFindings(run: CartographRun, stateById: Map<string, UIState>): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const finding of run.findings) {
    const state = stateById.get(finding.stateId);
    const key = `${finding.detector}:${normalizeSelector(finding.selector)}:${stateCluster(state)}`;
    const existing = groups.get(key);
    const categoryIds = categoryIdsForFinding(finding);
    if (existing) {
      existing.findingIds.push(finding.id);
      existing.stateIds = unique([...existing.stateIds, finding.stateId]);
      existing.severity = higherSeverity(existing.severity, finding.severity);
      existing.penalty = penaltyForGroup(existing.severity, existing.findingIds.length);
      existing.categoryIds = unique([...existing.categoryIds, ...categoryIds]);
      continue;
    }
    groups.set(key, {
      key,
      first: finding,
      severity: finding.severity,
      findingIds: [finding.id],
      stateIds: [finding.stateId],
      categoryIds,
      penalty: penaltyForGroup(finding.severity, 1)
    });
  }
  return Array.from(groups.values());
}

function categoryIdsForFinding(finding: UIFinding): BuildQualityCategoryId[] {
  const mapped = detectorScoreMap[finding.detector];
  if (mapped) return mapped;
  const detector = finding.detector.toLowerCase();
  if (detector.match(/network|console|error|exception/)) return ["error_health"];
  if (detector.match(/mobile|responsive|overflow|offscreen/)) return ["responsive_health", "visual_stability"];
  if (detector.match(/a11y|access|label|duplicate/)) return ["accessibility_smoke"];
  return ["interaction_health"];
}

function addInteractionSignals(run: CartographRun, signals: Map<BuildQualityCategoryId, MutableCategorySignals>): void {
  const signal = signals.get("interaction_health");
  if (!signal) return;
  const noEffect = run.transitions.filter((transition) => transition.status === "no_effect");
  const errors = run.transitions.filter((transition) => transition.status === "error");
  const blocked = run.transitions.filter((transition) => transition.status === "blocked");
  signal.penalty += Math.min(24, noEffect.length * 3 + errors.length * 6 + blocked.length * 4);
  if (run.summary.actionsAttempted === 0 && run.states.some((state) => state.interactiveCount > 0)) {
    signal.penalty += 28;
    for (const state of run.states.filter((item) => item.interactiveCount > 0).slice(0, 6)) {
      signal.evidenceStateIds.add(state.id);
    }
  }
  for (const transition of [...noEffect, ...errors, ...blocked]) {
    signal.evidenceStateIds.add(transition.toStateId);
  }
}

function addResponsiveSignals(run: CartographRun, signals: Map<BuildQualityCategoryId, MutableCategorySignals>): void {
  const signal = signals.get("responsive_health");
  if (!signal) return;
  const requestedMobile = run.options.viewports.some((viewport) => viewport.name === "mobile");
  const mobileStates = run.states.filter((state) => state.viewport === "mobile");
  if (requestedMobile && mobileStates.length === 0) {
    signal.penalty += 18;
  }
  if (!requestedMobile) {
    signal.penalty += 8;
  }
  for (const state of mobileStates) {
    const metrics = state.domSummary.metrics;
    const statePenalty = (metrics.overflowX > 8 ? 4 : 0) + (metrics.offscreenInteractiveCount > 0 ? 4 : 0) + (metrics.mainBlank ? 10 : 0);
    if (statePenalty > 0) {
      signal.penalty += Math.min(12, statePenalty);
      signal.evidenceStateIds.add(state.id);
    }
  }
}

function addAccessibilitySignals(run: CartographRun, signals: Map<BuildQualityCategoryId, MutableCategorySignals>): void {
  const signal = signals.get("accessibility_smoke");
  if (!signal) return;
  for (const state of run.states) {
    const metrics = state.domSummary.metrics;
    const missingBasics = metrics.duplicateIdCount + metrics.unnamedButtonCount + metrics.unlabeledInputCount;
    if (missingBasics > 0) {
      signal.penalty += Math.min(10, 3 + missingBasics * 2);
      signal.evidenceStateIds.add(state.id);
    }
  }
}

function addVisualSignals(run: CartographRun, signals: Map<BuildQualityCategoryId, MutableCategorySignals>): void {
  const signal = signals.get("visual_stability");
  if (!signal) return;
  for (const state of run.states) {
    const metrics = state.domSummary.metrics;
    const statePenalty =
      (metrics.mainBlank ? 14 : 0) +
      (metrics.textOverflowCount > 0 ? Math.min(8, metrics.textOverflowCount * 2) : 0) +
      (metrics.offscreenInteractiveCount > 0 ? 4 : 0) +
      (metrics.overflowX > 80 ? 4 : 0);
    if (statePenalty > 0) {
      signal.penalty += Math.min(16, statePenalty);
      signal.evidenceStateIds.add(state.id);
    }
  }
}

function stateCoverageScore(run: CartographRun): { score: number; summary: string; evidenceStateIds: string[] } {
  const requested = run.options.viewports.map((viewport) => viewport.name);
  const reached = unique(run.states.map((state) => state.viewport));
  const viewportPoints = requested.length === 0 ? 0 : (reached.filter((name) => requested.includes(name)).length / requested.length) * 18;
  const statePoints = Math.min(32, run.summary.stateCount * 4);
  const transitionPoints = Math.min(24, run.summary.transitionCount * 2.5);
  const actionPoints = run.summary.actionsAttempted > 0 ? 12 : 0;
  let score = 14 + viewportPoints + statePoints + transitionPoints + actionPoints;
  const exhaustedActionBudget = run.summary.actionsAttempted >= run.options.maxActions && run.options.maxActions > 0;
  const exhaustedTimeBudget = run.summary.durationMs >= run.options.maxDurationMs * 0.95;
  if (exhaustedActionBudget) score -= 16;
  if (exhaustedTimeBudget) score -= 12;
  if (run.summary.status === "stopped") score -= 24;
  if (run.summary.actionsAttempted === 0 && run.states.some((state) => state.interactiveCount > 0)) score -= 20;
  if (run.summary.stateCount === 0) score -= 28;
  const reason = run.summary.status === "stopped"
    ? "Crawl was stopped, so this is partial reachable-state coverage, not code coverage."
    : run.summary.actionsAttempted === 0 && run.states.some((state) => state.interactiveCount > 0)
      ? "Crawler captured interactive controls but did not complete any actions, so reachable-state confidence is limited. This is not code coverage."
    : exhaustedActionBudget
      ? "Crawl hit the action budget, so additional reachable states may remain. This is not code coverage."
      : "Crawl explored reachable states within the configured budget. This is not code coverage.";
  return {
    score: clampScore(score),
    summary: reason,
    evidenceStateIds: run.states.slice(0, 8).map((state) => state.id)
  };
}

function categorySummary(
  categoryId: BuildQualityCategoryId,
  score: number,
  run: CartographRun,
  groups: FindingGroup[],
  coverageSummary: string
): string {
  if (categoryId === "interaction_health") {
    const changed = run.transitions.filter((transition) => transition.status === "changed").length;
    return `${changed} of ${run.summary.actionsAttempted} attempted action(s) produced a changed state; ${countGroups(groups, categoryId)} interaction risk group(s) affected the score.`;
  }
  if (categoryId === "responsive_health") {
    const mobileStates = run.states.filter((state) => state.viewport === "mobile").length;
    return mobileStates > 0
      ? `${mobileStates} mobile state(s) were crawled; responsive findings and mobile layout metrics drive this score.`
      : "No mobile state was captured for this run, so responsive confidence is limited.";
  }
  if (categoryId === "error_health") {
    const consoleErrors = run.states.reduce((sum, state) => sum + state.consoleErrors.length, 0);
    const networkErrors = run.states.reduce((sum, state) => sum + state.networkErrors.length, 0);
    return `${consoleErrors} console error(s) and ${networkErrors} failed request signal(s) were recorded during crawled interactions.`;
  }
  if (categoryId === "accessibility_smoke") {
    const statesWithIssues = run.states.filter((state) => {
      const metrics = state.domSummary.metrics;
      return metrics.duplicateIdCount + metrics.unnamedButtonCount + metrics.unlabeledInputCount > 0;
    }).length;
    return `${statesWithIssues} state(s) had duplicate IDs, unnamed buttons, or unlabeled inputs. This is an accessibility smoke signal, not compliance.`;
  }
  if (categoryId === "state_coverage") return coverageSummary;
  return `${countGroups(groups, categoryId)} visual risk group(s) plus screenshot-derived blank, overflow, offscreen, and text overflow metrics shaped this score.`;
}

function topRisksForRun(run: CartographRun, groups: FindingGroup[], coverage: { score: number; summary: string; evidenceStateIds: string[] }): BuildQualityRisk[] {
  const risks = groups
    .map((group) => ({
      id: `risk-${slug(group.key)}`,
      title: group.first.title,
      severity: group.severity,
      categoryId: group.categoryIds[0],
      findingIds: group.findingIds,
      stateIds: group.stateIds,
      replayPath: group.first.replayPath,
      sortScore: buildQualityFormula.severityPenalty[group.severity] + group.findingIds.length
    }))
    .sort((a, b) => b.sortScore - a.sortScore)
    .map(({ sortScore: _sortScore, ...risk }) => risk);

  if (coverage.score < 75) {
    risks.push({
      id: "risk-state-coverage",
      title: coverage.summary,
      severity: coverage.score < 45 ? "critical" : "warning",
      categoryId: "state_coverage",
      findingIds: [],
      stateIds: coverage.evidenceStateIds,
      replayPath: run.states[0]?.replayPath
    });
  }

  return risks.slice(0, 5);
}

function strengthsForCategories(categories: BuildQualityCategoryScore[]): BuildQualityStrength[] {
  return categories
    .filter((category) => category.score >= 85)
    .slice(0, 4)
    .map((category) => ({
      id: `strength-${category.id}`,
      categoryId: category.id,
      title: `${category.label} held up`,
      detail: category.summary
    }));
}

function penaltyForGroup(severity: FindingSeverity, count: number): number {
  const base = buildQualityFormula.severityPenalty[severity];
  return base + Math.max(0, count - 1) * base * buildQualityFormula.repeatedFindingPenaltyMultiplier;
}

function countGroups(groups: FindingGroup[], categoryId: BuildQualityCategoryId): number {
  return groups.filter((group) => group.categoryIds.includes(categoryId)).length;
}

function higherSeverity(left: FindingSeverity, right: FindingSeverity): FindingSeverity {
  const rank: Record<FindingSeverity, number> = { info: 1, warning: 2, critical: 3 };
  return rank[right] > rank[left] ? right : left;
}

function stateCluster(state: UIState | undefined): string {
  if (!state) return "unknown";
  return `${state.viewport}:${state.fingerprint.overlayKey ?? state.fingerprint.urlKey ?? state.url}`;
}

function normalizeSelector(selector: string | undefined): string {
  return (selector ?? "state")
    .toLowerCase()
    .replace(/:nth-of-type\(\d+\)/g, ":nth-of-type(*)")
    .replace(/\d+/g, "#")
    .slice(0, 96);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "quality";
}

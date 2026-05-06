import { formatBuildQualityStatus, generateBuildQualityScoreboard } from "../quality/scoreboard.js";
import type { BuildQualityScoreboard, CartographRun, ReplayStep, UIFinding } from "../types.js";

function formatReplayStep(step: ReplayStep, index: number): string {
  if (step.type === "goto") return `${index + 1}. Go to ${step.url}`;
  if (step.type === "fill") return `${index + 1}. Fill ${step.label ?? step.selector} with "${step.value}"`;
  if (step.type === "select") return `${index + 1}. Select ${step.value ?? "first option"} in ${step.label ?? step.selector}`;
  if (step.type === "press") return `${index + 1}. Press ${step.key ?? "Enter"} on ${step.label ?? step.selector}`;
  if (step.type === "wait") return `${index + 1}. Wait ${step.timeoutMs ?? 250}ms`;
  return `${index + 1}. Click ${step.label ?? step.selector}`;
}

function findingMarkdown(finding: UIFinding): string {
  const evidence = finding.evidence.map((item) => `  - ${item.label}: ${item.value}`).join("\n");
  const replay = finding.replayPath.map(formatReplayStep).join("\n");
  return `### ${finding.severity.toUpperCase()}: ${finding.title}

- Detector: ${finding.detector}
- State: ${finding.stateId}
- Screenshot: ${finding.screenshotPath}
- Detail: ${finding.detail}

Evidence:
${evidence || "  - No structured evidence recorded."}

Replay:
${replay || "No replay path recorded."}
`;
}

function qualityMarkdown(run: CartographRun): string {
  const quality = run.quality ?? generateBuildQualityScoreboard(run);
  const categories = quality.categories
    .map((category) => `| ${category.label} | ${category.score} | ${category.summary} |`)
    .join("\n");
  const topRisks = quality.topRisks.map((risk, index) => {
    const replay = risk.replayPath?.map(formatReplayStep).join(" -> ") || "No replay path recorded.";
    return `${index + 1}. ${risk.title}
   Evidence: finding ${risk.findingIds.map((id) => `\`${id}\``).join(", ") || "run metadata"}, state ${risk.stateIds.map((id) => `\`${id}\``).join(", ") || "n/a"}.
   Replay: ${replay}`;
  });
  return `## Build Quality Scoreboard

Overall: ${quality.overallScore} / 100
Status: ${formatBuildQualityStatus(quality.status)}

| Category | Score | Summary |
|---|---:|---|
${categories}

### Top Risks

${topRisks.join("\n\n") || "No top risks were recorded."}

### Formula

${quality.formula.description}
`;
}

export function generateMarkdownReport(run: CartographRun): string {
  const summary = run.summary;
  const findings = run.findings.map(findingMarkdown).join("\n");
  return `# Interaction Cartographer Report

Start URL: ${run.startUrl}

Created: ${run.createdAt}

## Summary

| Metric | Value |
| --- | ---: |
| States | ${summary.stateCount} |
| Transitions | ${summary.transitionCount} |
| Findings | ${summary.findingCount} |
| Actions attempted | ${summary.actionsAttempted} |
| Duration | ${Math.round(summary.durationMs / 1000)}s |

${qualityMarkdown(run)}

## Severity Breakdown

| Severity | Count |
| --- | ---: |
| Critical | ${summary.issuesBySeverity.critical} |
| Warning | ${summary.issuesBySeverity.warning} |
| Info | ${summary.issuesBySeverity.info} |

## Findings

${findings || "No findings were recorded."}

## States

${run.states
  .map((state) => `- ${state.id}: ${state.label} (${state.viewport}) - ${state.screenshotPath}`)
  .join("\n")}
`;
}

export function generateFindingsMarkdown(run: CartographRun): string {
  const bySeverity = {
    critical: run.findings.filter((finding) => finding.severity === "critical").length,
    warning: run.findings.filter((finding) => finding.severity === "warning").length,
    info: run.findings.filter((finding) => finding.severity === "info").length
  };
  const findings = run.findings
    .map((finding, index) => {
      const state = run.states.find((item) => item.id === finding.stateId);
      const transition = run.transitions.find((item) => item.id === finding.transitionId);
      const evidence = finding.evidence.map((item) => `  - ${item.label}: ${item.value}`).join("\n");
      const replay = finding.replayPath.map(formatReplayStep).join("\n");
      return `## ${index + 1}. ${finding.title}

- Severity: ${finding.severity}
- Detector: ${finding.detector}
- URL: ${state?.url ?? "unknown"}
- State: ${finding.stateId}${state ? ` - ${state.label} (${state.viewport})` : ""}
- Action: ${transition?.action.label ?? finding.selector ?? "state-level finding"}
- Selector: ${finding.selector ?? "n/a"}
- Screenshot: ${finding.screenshotPath}
- Detail: ${finding.detail}

Evidence:
${evidence || "  - No structured evidence recorded."}

Replay:
${replay || "No replay path recorded."}
`;
    })
    .join("\n");

  return `# Interaction Cartographer Findings

Target: ${run.startUrl}

Created: ${run.createdAt}

## Summary

| Metric | Value |
| --- | ---: |
| States | ${run.summary.stateCount} |
| Transitions | ${run.summary.transitionCount} |
| Findings | ${run.summary.findingCount} |
| Critical | ${bySeverity.critical} |
| Warning | ${bySeverity.warning} |
| Info | ${bySeverity.info} |
| Actions attempted | ${run.summary.actionsAttempted} |

${qualityMarkdown(run)}

${findings || "No findings were recorded."}
`;
}

export function generateFindingsJson(run: CartographRun): string {
  const quality: BuildQualityScoreboard = run.quality ?? generateBuildQualityScoreboard(run);
  const payload = {
    target: run.startUrl,
    runId: run.id,
    createdAt: run.createdAt,
    summary: run.summary,
    quality,
    findings: run.findings.map((finding) => {
      const state = run.states.find((item) => item.id === finding.stateId);
      const transition = run.transitions.find((item) => item.id === finding.transitionId);
      return {
        ...finding,
        state: state
          ? {
              id: state.id,
              label: state.label,
              url: state.url,
              viewport: state.viewport,
              screenshotPath: state.screenshotPath,
              interactiveCount: state.interactiveCount,
              domSummary: state.domSummary
            }
          : null,
        transition: transition
          ? {
              id: transition.id,
              fromStateId: transition.fromStateId,
              toStateId: transition.toStateId,
              status: transition.status,
              durationMs: transition.durationMs,
              action: transition.action
            }
          : null
      };
    }),
    states: run.states,
    transitions: run.transitions,
    actions: run.transitions.map((transition) => transition.action)
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

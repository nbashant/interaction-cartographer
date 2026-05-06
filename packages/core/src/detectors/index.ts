import type {
  CrawlOptions,
  DetectorInput,
  FindingEvidence,
  FindingSeverity,
  UIFinding,
  UIState,
  UITransition
} from "../types.js";

type DetectorContext = {
  before?: UIState;
  after: UIState;
  transition?: UITransition;
  options: CrawlOptions;
};

function makeFinding(
  detector: string,
  severity: FindingSeverity,
  title: string,
  detail: string,
  context: DetectorContext,
  evidence: FindingEvidence[] = []
): UIFinding {
  const action = context.transition?.action;
  const seed = `${detector}:${context.after.id}:${action?.selector ?? "state"}:${title}:${detail.slice(0, 80)}`;
  return {
    id: seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 96),
    severity,
    detector,
    title,
    detail,
    stateId: context.after.id,
    transitionId: context.transition?.id,
    actionId: context.transition?.actionId,
    selector: action?.selector,
    screenshotPath: context.after.screenshotPath,
    evidence,
    replayPath: context.after.replayPath
  };
}

function actionLabel(transition?: UITransition): string {
  return transition?.action.label || transition?.action.selector || "the control";
}

export async function runDetectors(input: DetectorInput): Promise<UIFinding[]> {
  const context = input as DetectorContext;
  const findings: UIFinding[] = [];
  const { after, before, transition } = context;
  const metrics = after.domSummary.metrics;

  if (transition?.status === "no_effect" && transition.action.type === "click") {
    findings.push(
      makeFinding(
        "no-effect-click",
        "warning",
        `Clicking "${actionLabel(transition)}" did not change the UI`,
        "The action completed, but URL, DOM fingerprint, overlay state, and visible text stayed equivalent.",
        context,
        [
          { label: "Selector", value: transition.action.selector },
          { label: "Action", value: actionLabel(transition) }
        ]
      )
    );
  }

  for (const event of after.consoleErrors) {
    findings.push(
      makeFinding(
        "console-error",
        event.text.match(/uncaught|exception|typeerror|referenceerror/i) ? "critical" : "warning",
        "Console error after action",
        event.text,
        context,
        [
          { label: "Console type", value: event.type },
          { label: "Location", value: event.location ?? "unknown" }
        ]
      )
    );
  }

  for (const event of after.networkErrors) {
    findings.push(
      makeFinding(
        "network-error",
        (event.status ?? 0) >= 500 ? "critical" : "warning",
        `Network ${event.status ?? "failure"} during interaction`,
        `${event.method} ${event.url}`,
        context,
        [
          { label: "Status", value: String(event.status ?? event.failureText ?? "failed") },
          { label: "URL", value: event.url }
        ]
      )
    );
  }

  if (metrics.mainBlank || (metrics.visibleTextLength < 24 && metrics.elementCount < 16)) {
    findings.push(
      makeFinding(
        "blank-render",
        "critical",
        "Blank or near-blank render",
        "A large primary content region has little or no visible text after the interaction.",
        context,
        [
          { label: "Visible text characters", value: String(metrics.visibleTextLength) },
          { label: "Element count", value: String(metrics.elementCount) }
        ]
      )
    );
  }

  if (metrics.overflowX > 8) {
    findings.push(
      makeFinding(
        "horizontal-overflow",
        metrics.overflowX > 160 ? "critical" : "warning",
        "Horizontal overflow detected",
        `The document is ${metrics.overflowX}px wider than the viewport.`,
        context,
        [
          { label: "Viewport width", value: String(metrics.clientWidth) },
          { label: "Scroll width", value: String(metrics.scrollWidth) }
        ]
      )
    );
  }

  if (metrics.offscreenInteractiveCount > 0) {
    findings.push(
      makeFinding(
        "offscreen-interactive",
        "warning",
        "Interactive element is outside the viewport",
        `${metrics.offscreenInteractiveCount} visible enabled control(s) are clipped or positioned outside the viewport.`,
        context,
        [{ label: "Offscreen controls", value: String(metrics.offscreenInteractiveCount) }]
      )
    );
  }

  if (metrics.textOverflowCount > 0) {
    findings.push(
      makeFinding(
        "text-overlap-candidate",
        "warning",
        "Possible text overflow or overlap",
        "Visible text appears to exceed its element bounds. This is a heuristic detector.",
        context,
        [{ label: "Overflow candidates", value: String(metrics.textOverflowCount) }]
      )
    );
  }

  const closeLike = transition?.action.label?.match(/close|dismiss|cancel|×|x$/i);
  if (before && closeLike && before.domSummary.dialogs.length > 0 && after.domSummary.dialogs.length > 0) {
    findings.push(
      makeFinding(
        "modal-cannot-close",
        "critical",
        "Modal close control did not close the modal",
        `The dialog remained visible after clicking "${actionLabel(transition)}".`,
        context,
        [
          { label: "Dialog before", value: before.domSummary.dialogs.map((dialog) => dialog.label).join(", ") },
          { label: "Dialog after", value: after.domSummary.dialogs.map((dialog) => dialog.label).join(", ") }
        ]
      )
    );
  }

  const submitLike = transition?.action.label?.match(/continue|submit|save|apply|place order|checkout|confirm/i);
  if (submitLike && (transition?.status === "no_effect" || metrics.disabledSubmitLikeCount > 0)) {
    findings.push(
      makeFinding(
        "form-dead-end",
        "warning",
        "Form path appears blocked after submit-like action",
        "A submit-like control either had no effect or left submit controls disabled after validation.",
        context,
        [
          { label: "Action", value: actionLabel(transition) },
          { label: "Disabled submit-like controls", value: String(metrics.disabledSubmitLikeCount) }
        ]
      )
    );
  }

  if (metrics.duplicateIdCount > 0 || metrics.unnamedButtonCount > 0 || metrics.unlabeledInputCount > 0) {
    const details = [
      metrics.duplicateIdCount > 0 ? `${metrics.duplicateIdCount} duplicate id(s)` : "",
      metrics.unnamedButtonCount > 0 ? `${metrics.unnamedButtonCount} unnamed button(s)` : "",
      metrics.unlabeledInputCount > 0 ? `${metrics.unlabeledInputCount} unlabeled input(s)` : ""
    ]
      .filter(Boolean)
      .join(", ");
    findings.push(
      makeFinding(
        "accessibility-smoke",
        "warning",
        "Accessibility smoke check failed",
        details,
        context,
        [
          { label: "Duplicate IDs", value: String(metrics.duplicateIdCount) },
          { label: "Unnamed buttons", value: String(metrics.unnamedButtonCount) },
          { label: "Unlabeled inputs", value: String(metrics.unlabeledInputCount) }
        ]
      )
    );
  }

  if (transition && transition.fromStateId === transition.toStateId && transition.action.role === "link") {
    findings.push(
      makeFinding(
        "navigation-loop",
        "info",
        "Navigation loop returned to the same state",
        "A link action returned to a previously captured state.",
        context,
        [{ label: "Action", value: actionLabel(transition) }]
      )
    );
  }

  if (after.viewport === "mobile" && (metrics.mainBlank || metrics.overflowX > 80 || metrics.offscreenInteractiveCount > 0)) {
    findings.push(
      makeFinding(
        "mobile-only-breakage",
        metrics.mainBlank ? "critical" : "warning",
        "Mobile viewport breakage signal",
        "A detector found a blank, overflowing, or clipped state while scanning the mobile viewport.",
        context,
        [
          { label: "Overflow", value: String(metrics.overflowX) },
          { label: "Offscreen controls", value: String(metrics.offscreenInteractiveCount) }
        ]
      )
    );
  }

  return dedupeFindings(findings);
}

function dedupeFindings(findings: UIFinding[]): UIFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.detector}:${finding.stateId}:${finding.actionId ?? ""}:${finding.title}:${finding.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

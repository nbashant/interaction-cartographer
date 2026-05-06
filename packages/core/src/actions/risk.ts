import type { CandidateAction } from "../types.js";

const destructiveLabels = [
  "delete",
  "remove",
  "purchase",
  "pay",
  "send",
  "invite",
  "publish",
  "deploy",
  "push",
  "merge",
  "logout",
  "log out",
  "sign out",
  "upload"
];

const submitLabels = ["submit", "save", "continue", "apply", "place order", "checkout", "confirm"];

export function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function classifyActionRisk(input: {
  type: CandidateAction["type"];
  label?: string;
  href?: string;
  startUrl?: string;
  allowExternal?: boolean;
}): Pick<CandidateAction, "risk" | "reason"> {
  const label = (input.label ?? "").toLowerCase().trim();

  if (input.href && input.startUrl) {
    const target = new URL(input.href, input.startUrl);
    const start = new URL(input.startUrl);
    if (target.origin !== start.origin && !input.allowExternal) {
      return { risk: "blocked", reason: "Off-origin navigation is blocked by default." };
    }
  }

  if (destructiveLabels.some((word) => (word === "pay" ? /\bpay\b/.test(label) : label.includes(word)))) {
    return { risk: "blocked", reason: `Label matched destructive action text: ${label || "unlabeled"}.` };
  }

  if (input.type === "fill" || input.type === "select" || input.type === "hover") {
    return { risk: "safe", reason: "Non-destructive form or hover interaction." };
  }

  if (submitLabels.some((word) => label.includes(word))) {
    return { risk: "caution", reason: "Submit-like action; allowed only for local/demo or explicit submit mode." };
  }

  return { risk: "safe", reason: "Visible enabled same-origin interaction." };
}

export function actionPriority(action: CandidateAction): number {
  const label = (action.label ?? "").toLowerCase();
  let score = 10;
  if (action.role === "link") score += 8;
  if (["tab", "menuitem"].includes(action.role ?? "")) score += 9;
  if (label.match(/settings|billing|pipeline|checkout|cart|customer|details|mobile|menu|create|promo|continue|payment|open action|cobalt/)) score += 14;
  if (label.match(/checkout|promo|continue|payment|open action|billing|mobile menu|menu/)) score += 8;
  if (action.type === "fill" || action.type === "select") score += 4;
  if (action.risk === "caution") score -= 2;
  if (action.risk === "blocked") score -= 100;
  return score;
}

export function actionToReplayStep(action: CandidateAction, value?: string) {
  if (action.type === "fill") {
    return { type: "fill" as const, selector: action.selector, value: value ?? "cartographer@example.com", label: action.label };
  }
  if (action.type === "select") {
    return { type: "select" as const, selector: action.selector, value: value ?? "", label: action.label };
  }
  if (action.type === "press") {
    return { type: "press" as const, selector: action.selector, key: "Enter", label: action.label };
  }
  return { type: "click" as const, selector: action.selector, label: action.label };
}

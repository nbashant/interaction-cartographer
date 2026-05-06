import { createHash } from "node:crypto";
import type { DomSummary, StateFingerprint, ViewportName } from "../types.js";

export function stableHash(value: unknown): string {
  return createHash("sha1").update(stableStringify(value)).digest("hex").slice(0, 16);
}

export function hashString(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

export function normalizeUrlKey(input: string): string {
  const url = new URL(input);
  const params = [...url.searchParams.keys()].sort();
  const queryShape = params.length > 0 ? `?${params.map((key) => `${key}=*`).join("&")}` : "";
  return `${url.origin}${url.pathname.replace(/\/$/, "") || "/"}${queryShape}`;
}

function normalizeText(values: string[]): string[] {
  return values
    .join(" ")
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 120);
}

export function overlayKey(summary: DomSummary): string | undefined {
  if (summary.dialogs.length > 0) {
    return `dialog:${summary.dialogs.map((dialog) => dialog.label).join("|").toLowerCase()}`;
  }
  return undefined;
}

export function createFingerprint(input: {
  url: string;
  viewport: ViewportName;
  summary: DomSummary;
  screenshotHash: string;
}): StateFingerprint {
  const textTokens = normalizeText([
    ...input.summary.headings,
    ...input.summary.visibleTextSample.slice(0, 24)
  ]);
  const structure = {
    headings: input.summary.headings.map((heading) => heading.toLowerCase()),
    forms: input.summary.forms.map((form) => `${form.label}:${form.inputCount}:${form.submitCount}`),
    buttons: input.summary.buttons.map((button) => button.label.toLowerCase()).slice(0, 30),
    links: input.summary.links.map((link) => link.label.toLowerCase()).slice(0, 30),
    inputs: input.summary.inputs.map((field) => field.label.toLowerCase()).slice(0, 30),
    dialogs: input.summary.dialogs.map((dialog) => dialog.label.toLowerCase())
  };

  return {
    urlKey: normalizeUrlKey(input.url),
    textHash: stableHash(textTokens),
    domHash: stableHash(structure),
    roleHash: stableHash(input.summary.roles),
    visualHash: input.screenshotHash,
    viewportKey: input.viewport,
    overlayKey: overlayKey(input.summary)
  };
}

export function areSimilarFingerprints(a: StateFingerprint, b: StateFingerprint): boolean {
  if (a.viewportKey !== b.viewportKey) return false;
  if ((a.overlayKey ?? "") !== (b.overlayKey ?? "")) return false;
  if (a.urlKey === b.urlKey && a.domHash === b.domHash) return true;
  if (a.urlKey === b.urlKey && a.textHash === b.textHash && a.roleHash === b.roleHash) return true;
  return a.domHash === b.domHash && a.textHash === b.textHash && a.roleHash === b.roleHash;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

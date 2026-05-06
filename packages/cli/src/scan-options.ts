import { DEFAULT_VIEWPORTS, type ViewportConfig } from "@interaction-cartographer/core";

export type Flags = Record<string, string | boolean>;
export type NumberLimits = { min: number; max: number };

export function numberFromFlag(flags: Flags, key: string, fallback: number, limits: NumberLimits): number {
  return optionalNumberFromFlag(flags, key, limits) ?? fallback;
}

export function optionalNumberFromFlag(flags: Flags, key: string, limits: NumberLimits): number | undefined {
  const raw = flags[key];
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) throw new Error(`--${key} requires a numeric value.`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < limits.min || value > limits.max) {
    throw new Error(`--${key} must be a number between ${limits.min} and ${limits.max}.`);
  }
  return Math.floor(value);
}

export function parseViewports(value: string): ViewportConfig[] {
  const names = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (!names.length) throw new Error("At least one viewport is required. Use desktop, mobile, or desktop,mobile.");
  const viewportsByName = new Map(DEFAULT_VIEWPORTS.map((viewport) => [viewport.name, viewport]));
  const unknown = names.filter((name) => !viewportsByName.has(name as ViewportConfig["name"]));
  if (unknown.length) {
    throw new Error(`Unsupported viewport(s): ${unknown.join(", ")}. Use desktop, mobile, or desktop,mobile.`);
  }
  return names.map((name) => viewportsByName.get(name as ViewportConfig["name"])!);
}

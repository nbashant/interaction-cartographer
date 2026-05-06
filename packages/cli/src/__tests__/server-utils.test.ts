import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAssetPath, safeJoin } from "../server-utils.js";

describe("server path utilities", () => {
  it("keeps resolved paths inside the requested root", () => {
    const root = path.resolve("/tmp/cartograph-root");

    expect(safeJoin(root, "/assets/report.js")).toBe(path.join(root, "assets/report.js"));
    expect(safeJoin(root, "../cartograph-root-secret/file.txt")).toBeNull();
    expect(safeJoin(root, "/%2e%2e/cartograph-root-secret/file.txt")).toBeNull();
    expect(safeJoin(root, "/bad%00path")).toBeNull();
  });

  it("serves run assets only from their asset folders", () => {
    const runDir = path.resolve("/tmp/cartograph-run");

    expect(runAssetPath(runDir, "/screenshots/state.png")).toBe(path.join(runDir, "screenshots/state.png"));
    expect(runAssetPath(runDir, "/replays/finding.spec.ts")).toBe(path.join(runDir, "replays/finding.spec.ts"));
    expect(runAssetPath(runDir, "/screenshots/../run.json")).toBeNull();
    expect(runAssetPath(runDir, "/findings.json")).toBeNull();
  });
});

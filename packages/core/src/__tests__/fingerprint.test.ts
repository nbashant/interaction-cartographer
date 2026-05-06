import { describe, expect, it } from "vitest";
import { areSimilarFingerprints, createFingerprint, normalizeUrlKey } from "../state/fingerprint.js";
import type { DomSummary } from "../types.js";

function summary(label: string): DomSummary {
  return {
    headings: [label],
    visibleTextSample: [label, "Primary content"],
    roles: { button: 2, link: 1 },
    forms: [],
    buttons: [{ selector: "#save", label: "Save", tagName: "button", role: "button" }],
    links: [{ selector: "#settings", label: "Settings", tagName: "a", role: "link" }],
    inputs: [],
    dialogs: [],
    metrics: {
      elementCount: 12,
      visibleTextLength: 80,
      scrollWidth: 1440,
      clientWidth: 1440,
      overflowX: 0,
      duplicateIdCount: 0,
      unnamedButtonCount: 0,
      unlabeledInputCount: 0,
      offscreenInteractiveCount: 0,
      textOverflowCount: 0,
      mainBlank: false,
      disabledSubmitLikeCount: 0
    }
  };
}

describe("state fingerprinting", () => {
  it("normalizes query values to query shape", () => {
    expect(normalizeUrlKey("http://localhost:3000/customers?id=123&tab=billing")).toBe("http://localhost:3000/customers?id=*&tab=*");
  });

  it("keeps equivalent states similar and distinct headings different", () => {
    const first = createFingerprint({ url: "http://localhost:3000/settings", viewport: "desktop", summary: summary("Settings"), screenshotHash: "a" });
    const second = createFingerprint({ url: "http://localhost:3000/settings", viewport: "desktop", summary: summary("Settings"), screenshotHash: "b" });
    const third = createFingerprint({ url: "http://localhost:3000/pipeline", viewport: "desktop", summary: summary("Pipeline"), screenshotHash: "c" });

    expect(areSimilarFingerprints(first, second)).toBe(true);
    expect(areSimilarFingerprints(first, third)).toBe(false);
  });
});

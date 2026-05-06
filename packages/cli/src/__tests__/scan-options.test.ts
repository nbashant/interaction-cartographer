import { describe, expect, it } from "vitest";
import { numberFromFlag, optionalNumberFromFlag, parseViewports } from "../scan-options.js";

describe("scan option parsing", () => {
  it("validates numeric flags instead of forwarding NaN or unsafe values", () => {
    expect(numberFromFlag({ port: "4199" }, "port", 4173, { min: 1, max: 65_535 })).toBe(4199);
    expect(numberFromFlag({}, "port", 4173, { min: 1, max: 65_535 })).toBe(4173);
    expect(optionalNumberFromFlag({ "max-actions": "42.7" }, "max-actions", { min: 1, max: 1_000 })).toBe(42);
    expect(() => numberFromFlag({ port: "nope" }, "port", 4173, { min: 1, max: 65_535 })).toThrow("--port must be a number");
    expect(() => optionalNumberFromFlag({ "max-depth": true }, "max-depth", { min: 0, max: 30 })).toThrow("--max-depth requires");
    expect(() => optionalNumberFromFlag({ "max-actions": "0" }, "max-actions", { min: 1, max: 1_000 })).toThrow("--max-actions must be");
  });

  it("rejects unknown viewports instead of silently falling back to defaults", () => {
    expect(parseViewports("desktop,mobile").map((viewport) => viewport.name)).toEqual(["desktop", "mobile"]);
    expect(parseViewports("mobile,mobile").map((viewport) => viewport.name)).toEqual(["mobile"]);
    expect(() => parseViewports("tablet")).toThrow("Unsupported viewport");
    expect(() => parseViewports("")).toThrow("At least one viewport");
  });
});

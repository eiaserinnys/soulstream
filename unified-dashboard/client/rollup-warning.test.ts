import { describe, expect, it, vi } from "vitest";
import { handleRollupWarning } from "../rollup-warning";

describe("Rollup warning handler", () => {
  it("fails the build for a circular chunk", () => {
    const warn = vi.fn();
    expect(() => handleRollupWarning({ code: "CIRCULAR_CHUNK", message: "Circular chunk: a -> b -> a" }, warn))
      .toThrow("Circular chunk: a -> b -> a");
    expect(() => handleRollupWarning({ code: "CIRCULAR_DEPENDENCY", message: "Circular chunk: a -> b -> a" }, warn))
      .toThrow("Circular chunk: a -> b -> a");
    expect(() => handleRollupWarning({ code: "CIRCULAR_CHUNK", message: "" }, warn))
      .toThrow("Circular chunk detected");
    expect(warn).not.toHaveBeenCalled();
  });

  it("forwards ordinary module cycles and other warnings", () => {
    const warn = vi.fn();
    const moduleCycle = { code: "CIRCULAR_DEPENDENCY", message: "Circular dependency: node_modules/a -> b -> a" };
    const other = { code: "OTHER", message: "Circular chunk: text in another warning" };
    handleRollupWarning(moduleCycle, warn);
    handleRollupWarning(other, warn);
    expect(warn.mock.calls).toEqual([[moduleCycle], [other]]);
  });
});

import { describe, expect, it } from "vitest";

import { sessionLensState, type PageLens } from "./page-lenses";

describe("page lenses", () => {
  it.each<[PageLens, string, string]>([
    ["default", "running", "neutral"],
    ["running", "running", "match"],
    ["running", "completed", "dimmed"],
    ["completed", "completed", "match"],
    ["completed", "error", "dimmed"],
  ])("maps %s lens + %s without creating a new status", (lens, status, expected) => {
    expect(sessionLensState(status as never, lens)).toBe(expected);
  });

  it("does not classify non-session rows", () => {
    expect(sessionLensState(undefined, "running")).toBe("neutral");
  });
});

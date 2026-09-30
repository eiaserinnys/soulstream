import { describe, expect, it } from "vitest";
import { assertCardTransition } from "../src/cards/card_status.js";

describe("card state authority", () => {
  it("rejects agent done even with a report", () => {
    expect(() => assertCardTransition("running", "done", "agent", 1, null)).toThrow(/human/i);
  });
  it("rejects review without a report for every actor", () => {
    for (const actor of ["agent", "user", "system"] as const) {
      expect(() => assertCardTransition("running", "review", actor, 0, null)).toThrow(/report/i);
    }
  });
  it("allows agent review with evidence and question blocking", () => {
    expect(() => assertCardTransition("running", "review", "agent", 1, null)).not.toThrow();
    expect(() => assertCardTransition("running", "blocked", "agent", 0, "question")).not.toThrow();
  });
  it("rejects other agent transitions and non-question blocking", () => {
    for (const status of ["todo", "queued", "running", "cancelled"] as const) {
      expect(() => assertCardTransition("running", status, "agent", 1, null)).toThrow();
    }
    expect(() => assertCardTransition("todo", "review", "agent", 1, null)).toThrow();
    expect(() => assertCardTransition("running", "blocked", "agent", 1, "limit")).toThrow();
  });
  it("allows human completion and requires a blocked kind", () => {
    expect(() => assertCardTransition("review", "done", "user", 1, null)).not.toThrow();
    expect(() => assertCardTransition("queued", "blocked", "system", 0, null)).toThrow();
  });
});

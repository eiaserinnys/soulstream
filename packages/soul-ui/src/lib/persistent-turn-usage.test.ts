import { describe, expect, it } from "vitest";

import { pairTurnUsage } from "./persistent-turn-usage";

describe("pairTurnUsage", () => {
  it("pairs pending context with a complete without changing payload identity", () => {
    const contextUsage = { percent: 32.6 };
    const complete = { usage: { input_tokens: 12, output_tokens: 3 } };
    const pairs = pairTurnUsage<unknown>([
      { id: 10, type: "context_usage", data: contextUsage },
      { id: 11, type: "complete", data: complete },
    ]);

    expect(pairs).toEqual([{
      terminalId: 11,
      terminalType: "complete",
      contextUsage,
      complete,
    }]);
    expect(pairs[0].contextUsage).toBe(contextUsage);
    expect(pairs[0].complete).toBe(complete);
  });

  it("emits a complete with no pending context", () => {
    expect(pairTurnUsage<unknown>([{ id: "terminal", type: "complete", data: {} }])).toEqual([{
      terminalId: "terminal",
      terminalType: "complete",
      contextUsage: null,
      complete: {},
    }]);
  });

  it("pairs pending context with an error and leaves complete null", () => {
    const contextUsage = { percent: 14.2 };
    expect(pairTurnUsage<unknown>([
      { id: 1, type: "context_usage", data: contextUsage },
      { id: 2, type: "error", data: { message: "failed" } },
    ])).toEqual([{
      terminalId: 2,
      terminalType: "error",
      contextUsage,
      complete: null,
    }]);
  });

  it("emits no pair for an error without pending context", () => {
    expect(pairTurnUsage<unknown>([{ id: 1, type: "error", data: { message: "failed" } }])).toEqual([]);
  });

  it("drops pending context at user, generation, and intervention boundaries", () => {
    expect(pairTurnUsage<unknown>([
      { id: 1, type: "context_usage", data: { percent: 1 } },
      { id: 2, type: "user_message", data: {} },
      { id: 3, type: "complete", data: {} },
      { id: 4, type: "context_usage", data: { percent: 2 } },
      { id: 5, type: "generation_started", data: {} },
      { id: 6, type: "complete", data: {} },
      { id: 7, type: "context_usage", data: { percent: 3 } },
      { id: 8, type: "intervention_sent", data: {} },
      { id: 9, type: "error", data: {} },
    ])).toEqual([
      { terminalId: 3, terminalType: "complete", contextUsage: null, complete: {} },
      { terminalId: 6, terminalType: "complete", contextUsage: null, complete: {} },
    ]);
  });

  it("drops context that reaches the end without a terminal event", () => {
    expect(pairTurnUsage<unknown>([
      { id: 1, type: "context_usage", data: { percent: 1 } },
    ])).toEqual([]);
  });

  it("keeps only the newest context usage before a terminal", () => {
    const newest = { percent: 18.4 };
    expect(pairTurnUsage<unknown>([
      { id: 1, type: "context_usage", data: { percent: 10.2 } },
      { id: 2, type: "context_usage", data: newest },
      { id: 3, type: "complete", data: {} },
    ])).toEqual([{
      terminalId: 3,
      terminalType: "complete",
      contextUsage: newest,
      complete: {},
    }]);
  });
});

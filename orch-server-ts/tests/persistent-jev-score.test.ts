import { describe, expect, it, vi } from "vitest";

import { scorePersistentCandidates } from "../src/relevance/typesafe_client.js";

describe("scorePersistentCandidates", () => {
  it("scores all candidates in one Jev request and preserves the 0–3 scale", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ answers: {
        a: { score: 0 },
        b: { score: 3 },
      } }), { status: 200 });
    });

    await expect(scorePersistentCandidates({
      query: "현재 요청",
      items: [{ key: "a", text: "과거 A" }, { key: "b", text: "과거 B" }],
      apiKey: "test-key",
      budgetMs: 500,
      fetchImpl,
    })).resolves.toEqual([{ key: "a", score: 0 }, { key: "b", score: 3 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails the whole score set when one candidate score is absent or invalid", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ answers: {
      a: { score: 2 },
      b: { score: 4 },
    } }), { status: 200 }));

    await expect(scorePersistentCandidates({
      query: "현재 요청",
      items: [{ key: "a", text: "과거 A" }, { key: "b", text: "과거 B" }],
      apiKey: "test-key",
      budgetMs: 500,
      fetchImpl,
    })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not start a Jev request after the remaining budget expires", async () => {
    const fetchImpl = vi.fn();
    await expect(scorePersistentCandidates({
      query: "현재 요청",
      items: [{ key: "a", text: "과거 A" }],
      apiKey: "test-key",
      budgetMs: 0,
      fetchImpl,
    })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

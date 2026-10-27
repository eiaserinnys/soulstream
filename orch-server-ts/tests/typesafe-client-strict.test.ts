import { describe, expect, it, vi } from "vitest";
import { rankByRelevance } from "../src/relevance/typesafe_client.js";

function response(answers: Record<string, { score?: unknown }>) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ answers }));
  return fetchImpl;
}

describe("rankByRelevance strict score mode", () => {
  it("requires a finite score from 0 to 3 for every requested candidate", async () => {
    const fetchImpl = response({ first: { score: 3 }, second: { score: 1.5 } });
    await expect(rankByRelevance({
      query: "task",
      items: [{ key: "first", text: "First" }, { key: "second", text: "Second" }],
      apiKey: "test-key",
      fetchImpl,
      strictScores: true,
    })).resolves.toEqual([{ key: "first", score: 1 }, { key: "second", score: 0.5 }]);
  });

  it.each([
    ["missing", { first: { score: 2 } }],
    ["below range", { first: { score: 2 }, second: { score: -1 } }],
    ["above range", { first: { score: 2 }, second: { score: 4 } }],
    ["non-finite", { first: { score: 2 }, second: { score: Number.NaN } }],
  ] as const)("rejects a %s candidate score", async (_case, answers) => {
    await expect(rankByRelevance({
      query: "task",
      items: [{ key: "first", text: "First" }, { key: "second", text: "Second" }],
      apiKey: "test-key",
      fetchImpl: response(answers),
      strictScores: true,
    })).rejects.toThrow("invalid score");
  });

  it("keeps permissive legacy scoring when strict mode is omitted", async () => {
    await expect(rankByRelevance({
      query: "task",
      items: [{ key: "missing", text: "Missing" }],
      apiKey: "test-key",
      fetchImpl: response({}),
    })).resolves.toEqual([{ key: "missing", score: 0 }]);
  });
});

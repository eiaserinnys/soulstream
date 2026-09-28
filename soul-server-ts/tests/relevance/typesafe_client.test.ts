import { describe, expect, it, vi } from "vitest";

import { rankByRelevance } from "../../src/relevance/typesafe_client.js";

describe("rankByRelevance", () => {
  it("sends the Jev runner wire shape and returns normalized scores descending", async () => {
    const items = [
      { key: "alpha", text: "Alpha description" },
      { key: "beta", text: "Beta description" },
      { key: "gamma", text: "Gamma description" },
      { key: "delta", text: "Delta description" },
    ];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        answers: {
          alpha: { type: "score", score: 2 },
          beta: { type: "score", score: 3 },
          gamma: { type: "score", score: "invalid" },
          delta: { type: "score" },
        },
      }), { status: 200 }),
    );

    const result = await rankByRelevance({
      query: "Find the matching skill",
      items,
      apiKey: "typesafe-test-key",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer typesafe-test-key",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      state: { first_request: string; candidates: Array<{ key: string; text: string }> };
      questions: Record<string, { type: string; instructions: string; criteria: string[] }>;
    };
    expect(body.model).toBe("jev-latest");
    expect(body.state.first_request).toBe("Find the matching skill");
    expect(body.state.candidates).toEqual(items);
    expect(JSON.stringify(body.state)).toContain("Alpha description");
    expect(Object.keys(body.questions)).toEqual(items.map((item) => item.key));
    expect(body.questions.alpha).toMatchObject({
      type: "score",
      instructions: "first_request 처리에 대한 아래 지식 카드의 유관도.\n카드: Alpha description",
      criteria: [
        "무관 — 이 요청과 관계없다",
        "참고 — 있으면 약간 도움",
        "유관 — 처리 과정에 실제로 쓰인다",
        "필수 — 없으면 요청 처리가 틀리거나 누락된다",
      ],
    });
    expect(result).toEqual([
      { key: "beta", score: 1 },
      { key: "alpha", score: 2 / 3 },
      { key: "gamma", score: 0 },
      { key: "delta", score: 0 },
    ]);
  });

  it("does not include the API key in errors", async () => {
    const apiKey = "secret-test-key";
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(
      new Error(`upstream failure echoed ${apiKey}`),
    );

    const error = await rankByRelevance({
      query: "query",
      items: [{ key: "one", text: "One" }],
      apiKey,
      fetchImpl,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(apiKey);
  });
});

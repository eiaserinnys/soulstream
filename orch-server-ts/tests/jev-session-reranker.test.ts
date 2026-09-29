import { describe, expect, it, vi } from "vitest";

import {
  buildJevPayload,
  rerankSessionDocuments,
  type JevSessionCandidate,
} from "../src/search/jev_session_reranker.js";

describe("Jev session reranker", () => {
  it("uses the frozen N/C3 wording and puts the query once in state", () => {
    const built = buildJevPayload("하니엘 계약 구조", [candidate("s1")]);
    const state = JSON.parse(built.payload.state) as Record<string, unknown>;
    expect(state).toEqual({
      context: "소울스트림은 사용자가 AI 에이전트와 진행한 작업 세션을 기록하는 시스템이다. 사용자가 예전에 진행한 세션을 다시 찾으려고 검색어를 입력했다. candidates는 후보 세션 카드다. title은 세션 제목, request는 첫 요청, summary는 진행 요약, date는 시작일, agent는 담당 에이전트다.",
      rule: "각 질문은 지정한 ref의 후보 세션이 검색어가 가리키는 작업이나 대화를 한 세션인지 묻는다.",
      query: "하니엘 계약 구조",
      candidates: [{ ref: "c0", title: "제목", request: "첫 요청", summary: "요약", date: "2026-09-29", agent: "roselin" }],
    });
    expect(built.payload.questions).toEqual({
      c0: {
        type: "noul",
        instructions: "대상 c0: 검색어가 가리키는 세션인가",
        criteria: { true: "해당함", false: "해당하지 않음" },
      },
    });
    expect(built.payload.state.match(/하니엘 계약 구조/g)).toHaveLength(1);
  });

  it("sends an oversized pool in exactly two concurrent requests", async () => {
    const pending: Array<() => void> = [];
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      return new Promise<Response>((resolve) => {
        pending.push(() => resolve(jsonResponse({
          answers: Object.fromEntries(Object.keys(payload.questions).map((key) => [key, { noul: 0.5 }])),
        })));
      });
    });
    const run = rerankSessionDocuments("secret", "질의", Array.from({ length: 50 }, (_, i) => candidate(`s${i}`, "한글😀".repeat(100))), { fetcher });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    pending.forEach((resolve) => resolve());
    const outcome = await run;
    if (outcome.status !== "complete") throw new Error("expected Jev reranking to complete");
    expect(outcome.scores.size).toBe(50);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("marks a missing key and missing noul answer as errors", async () => {
    await expect(rerankSessionDocuments(null, "질의", [candidate("s1")] )).resolves.toMatchObject({
      status: "partial",
      reason: "error",
      scores: null,
    });
    await expect(rerankSessionDocuments("secret", "질의", [candidate("s1")], {
      fetcher: vi.fn(async () => jsonResponse({ answers: {} })),
    })).resolves.toMatchObject({
      status: "partial",
      reason: "error",
      scores: null,
    });
  });

  it("maps a Jev timeout to the public timeout reason without retrying", async () => {
    const controller = new AbortController();
    const timeoutController = new AbortController();
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      timeoutController.abort();
      return await new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("timeout", "TimeoutError"));
          return;
        }
        signal.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")), { once: true });
      });
    });
    const result = await rerankSessionDocuments("secret", "질의", [candidate("s1")], {
      fetcher,
      signal: controller.signal,
      timeoutSignal: () => timeoutController.signal,
    });
    expect(result).toMatchObject({ status: "partial", reason: "timeout", scores: null });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

function candidate(sessionId: string, text = "요약"): JevSessionCandidate {
  return {
    session_id: sessionId,
    card: {
      title: "제목",
      request: "첫 요청",
      summary: text,
      date: "2026-09-29",
      agent: "roselin",
    },
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

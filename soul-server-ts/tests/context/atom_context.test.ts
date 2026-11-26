/**
 * atom_context 단위 회귀 — Python `service/atom_context.py` 정본 정합.
 */

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchAtomMarkdownResult,
  formatAtomContext,
} from "../../src/context/atom_context.js";

const silentLogger = pino({ level: "silent" });

describe("formatAtomContext (Python format_atom_context 정본)", () => {
  it("두 ID + chars → [node:X card:Y] (N chars)", () => {
    const input = `├── 시스템 <!-- node:11111111-2222-3333-4444-555555555555 card:66666666-7777-8888-9999-aaaaaaaaaaaa depth:1 chars:42 -->`;
    const out = formatAtomContext(input);
    expect(out).toContain(
      "├── 시스템 [node:11111111-2222-3333-4444-555555555555 card:66666666-7777-8888-9999-aaaaaaaaaaaa] (42 chars)",
    );
  });

  it("두 ID + chars 없음 → [node:X card:Y]", () => {
    const input = `## 시스템 <!-- node:11111111-2222-3333-4444-555555555555 card:66666666-7777-8888-9999-aaaaaaaaaaaa depth:1 -->`;
    const out = formatAtomContext(input);
    expect(out).toContain(
      "## 시스템 [node:11111111-2222-3333-4444-555555555555 card:66666666-7777-8888-9999-aaaaaaaaaaaa]",
    );
  });

  it("구 단일 ID + chars → [X] (N chars)", () => {
    const input = `~ 심링크 <!-- node:11111111-2222-3333-4444-555555555555 depth:2 chars:0 -->`;
    const out = formatAtomContext(input);
    expect(out).toContain("~ 심링크 [11111111-2222-3333-4444-555555555555] (0 chars)");
  });

  it("HTML 주석 없는 라인 → idempotent 통과", () => {
    const input = "├── plain text\n*(cycle)*";
    const out = formatAtomContext(input);
    expect(out).toContain("├── plain text");
    expect(out).toContain("*(cycle)*");
  });

  it("ATOM_CONTEXT_HEADER prepend", () => {
    const out = formatAtomContext("body");
    expect(out.startsWith("# atom 트리 | 드릴다운:")).toBe(true);
  });
});

describe("fetchAtomMarkdownResult", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("atom 비활성 → fetch 호출 안 함, null 반환", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    const out = await fetchAtomMarkdownResult(
      { enabled: false, serverUrl: "https://atom", apiKey: "k" },
      { nodeId: "node-1", depth: 3, titlesOnly: false },
      silentLogger,
    );
    expect(out).toEqual({ status: "empty", markdown: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serverUrl 빈 문자열 → fetch 호출 안 함, null 반환", async () => {
    const out = await fetchAtomMarkdownResult(
      { enabled: true, serverUrl: "", apiKey: "k" },
      { nodeId: "node-1", depth: 3, titlesOnly: false },
      silentLogger,
    );
    expect(out).toEqual({ status: "empty", markdown: null });
  });

  it("200 응답에 markdown 있으면 그대로 반환", async () => {
    const fetchMock = vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ markdown: "## 노드\nplain" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const out = await fetchAtomMarkdownResult(
      { enabled: true, serverUrl: "https://atom.test", apiKey: "k" },
      { nodeId: "n-1", depth: 3, titlesOnly: true },
      silentLogger,
    );
    expect(out).toEqual({ status: "ok", markdown: "## 노드\nplain" });

    // URL 정합
    const callUrl = fetchMock.mock.calls[0]?.[0]?.toString() ?? "";
    expect(callUrl).toContain("/api/tree/n-1/compile");
    expect(callUrl).toContain("depth=3");
    expect(callUrl).toContain("titles_only=true");
    expect(callUrl).toContain("include_ids=true");
    expect(callUrl).toContain("max_chars=50000");
    expect(callUrl).not.toContain("limit=");

    // x-api-key header
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });

  it("limit 값마다 compile 요청과 반환 context가 달라진다", async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
      .mockImplementation(async (input) => {
        const limit = new URL(input.toString()).searchParams.get("limit");
        return new Response(JSON.stringify({ markdown: `compiled-${limit}` }), { status: 200 });
      });

    const limitedToOne = await fetchAtomMarkdownResult(
      { enabled: true, serverUrl: "https://atom.test", apiKey: "k" },
      { nodeId: "n-1", depth: 1, titlesOnly: false, limit: 1 },
      silentLogger,
    );
    const limitedToThree = await fetchAtomMarkdownResult(
      { enabled: true, serverUrl: "https://atom.test", apiKey: "k" },
      { nodeId: "n-3", depth: 1, titlesOnly: false, limit: 3 },
      silentLogger,
    );

    expect(new URL(fetchMock.mock.calls[0]![0].toString()).searchParams.get("limit")).toBe("1");
    expect(new URL(fetchMock.mock.calls[1]![0].toString()).searchParams.get("limit")).toBe("3");
    expect(limitedToOne.markdown).toBe("compiled-1");
    expect(limitedToThree.markdown).toBe("compiled-3");
  });

  it("non-200 → null (graceful)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("err", { status: 503 }),
    );
    const out = await fetchAtomMarkdownResult(
      { enabled: true, serverUrl: "https://atom.test", apiKey: "k" },
      { nodeId: "n", depth: 3, titlesOnly: false },
      silentLogger,
    );
    expect(out).toEqual({ status: "error", markdown: null });
  });

  it("network throw → null result", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const out = await fetchAtomMarkdownResult(
      { enabled: true, serverUrl: "https://atom.test", apiKey: "k" },
      { nodeId: "n", depth: 3, titlesOnly: false },
      silentLogger,
    );
    expect(out).toEqual({ status: "error", markdown: null });
  });

  it("lets a single request return a normal 6-second response before its deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.mocked(globalThis.fetch).mockImplementationOnce(
        (_input, init) => new Promise<Response>((resolve, reject) => {
          const responseTimer = setTimeout(() => {
            resolve(new Response(JSON.stringify({ markdown: "late but valid" }), { status: 200 }));
          }, 6_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(responseTimer);
            reject(init.signal?.reason);
          }, { once: true });
        }),
      );
      const result = fetchAtomMarkdownResult(
        { enabled: true, serverUrl: "https://atom.test", apiKey: "k" },
        { nodeId: "node-1", depth: 3, titlesOnly: false },
        silentLogger,
      );

      await vi.advanceTimersByTimeAsync(6_000);

      await expect(result).resolves.toEqual({ status: "ok", markdown: "late but valid" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts one pending request at 30 seconds and returns an error result", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchMock = vi.mocked(globalThis.fetch).mockImplementationOnce(
        (_input, init) => new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
        }),
      );
      let settled = false;
      const result = fetchAtomMarkdownResult(
        { enabled: true, serverUrl: "https://atom.test", apiKey: "k" },
        { nodeId: "node-1", depth: 3, titlesOnly: false },
        silentLogger,
      ).then((value) => {
        settled = true;
        return value;
      });

      await vi.advanceTimersByTimeAsync(29_999);
      expect(signal?.aborted).toBe(false);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(result).resolves.toEqual({ status: "error", markdown: null });
      expect(signal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the deadline timer when a request fails before the deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(fetchAtomMarkdownResult(
        { enabled: true, serverUrl: "https://atom.test", apiKey: "k" },
        { nodeId: "node-1", depth: 3, titlesOnly: false },
        silentLogger,
      )).resolves.toEqual({ status: "error", markdown: null });

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("응답에 markdown 키 없으면 null", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const out = await fetchAtomMarkdownResult(
      { enabled: true, serverUrl: "https://atom.test", apiKey: "k" },
      { nodeId: "n", depth: 3, titlesOnly: false },
      silentLogger,
    );
    expect(out).toEqual({ status: "empty", markdown: null });
  });
});

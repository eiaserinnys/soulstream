/**
 * atom_context 단위 회귀 — Python `service/atom_context.py` 정본 정합.
 */

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchAtomContext,
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

describe("fetchAtomContext (Python fetch_atom_context 정본)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("atom 비활성 → fetch 호출 안 함, null 반환", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    const out = await fetchAtomContext(
      { enabled: false, serverUrl: "https://atom", apiKey: "k" },
      "node-1",
      3,
      false,
      silentLogger,
    );
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serverUrl 빈 문자열 → fetch 호출 안 함, null 반환", async () => {
    const out = await fetchAtomContext(
      { enabled: true, serverUrl: "", apiKey: "k" },
      "node-1",
      3,
      false,
      silentLogger,
    );
    expect(out).toBeNull();
  });

  it("200 응답에 markdown 있으면 formatAtomContext 적용 반환", async () => {
    const fetchMock = vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ markdown: "## 노드\nplain" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const out = await fetchAtomContext(
      { enabled: true, serverUrl: "https://atom.test", apiKey: "k" },
      "n-1",
      3,
      true,
      silentLogger,
    );
    expect(out).not.toBeNull();
    expect(out).toContain("## 노드");
    expect(out!.startsWith("# atom 트리")).toBe(true);

    // URL 정합
    const callUrl = fetchMock.mock.calls[0]?.[0]?.toString() ?? "";
    expect(callUrl).toContain("/api/tree/n-1/compile");
    expect(callUrl).toContain("depth=3");
    expect(callUrl).toContain("titles_only=true");
    expect(callUrl).toContain("include_ids=true");
    expect(callUrl).toContain("max_chars=50000");

    // x-api-key header
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });

  it("non-200 → null (graceful)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("err", { status: 503 }),
    );
    const out = await fetchAtomContext(
      { enabled: true, serverUrl: "https://atom.test", apiKey: "k" },
      "n",
      3,
      false,
      silentLogger,
    );
    expect(out).toBeNull();
  });

  it("network throw → null (graceful, turn 진행 차단 안 함)", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const out = await fetchAtomContext(
      { enabled: true, serverUrl: "https://atom.test", apiKey: "k" },
      "n",
      3,
      false,
      silentLogger,
    );
    expect(out).toBeNull();
  });

  it("응답에 markdown 키 없으면 null", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const out = await fetchAtomContext(
      { enabled: true, serverUrl: "https://atom.test", apiKey: "k" },
      "n",
      3,
      false,
      silentLogger,
    );
    expect(out).toBeNull();
  });
});

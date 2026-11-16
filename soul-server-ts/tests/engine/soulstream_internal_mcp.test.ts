/**
 * soulstream 내부 MCP 판정의 정본.
 *
 * 이름 정규화(앞뒤 공백)와 「내부 대상」(이름 + http/streamable_http) 판정을
 * 네 백엔드, full 세션 자격 교체, restricted 정제가 같은 함수로 쓴다.
 */
import { describe, expect, it } from "vitest";

import {
  isSoulstreamInternalMcpServer,
  isSoulstreamMcpServerName,
  normalizeSoulstreamMcpServerName,
} from "../../src/engine/soulstream_internal_mcp.js";

describe("soulstream internal MCP judgment", () => {
  it("normalizes surrounding whitespace in server names", () => {
    expect(normalizeSoulstreamMcpServerName("  soulstream  ")).toBe("soulstream");
    expect(normalizeSoulstreamMcpServerName("soulstream-cogito")).toBe(
      "soulstream-cogito",
    );
  });

  it("matches soulstream names after normalization", () => {
    expect(isSoulstreamMcpServerName(" soulstream ")).toBe(true);
    expect(isSoulstreamMcpServerName("soulstream-cogito\t")).toBe(true);
    expect(isSoulstreamMcpServerName(" soul-server-ts")).toBe(true);
    expect(isSoulstreamMcpServerName("atom")).toBe(false);
    expect(isSoulstreamMcpServerName("soulstream-extra")).toBe(false);
  });

  it("treats trimmed soulstream names on http transports as internal targets", () => {
    expect(
      isSoulstreamInternalMcpServer({ name: " soulstream ", type: "http" }),
    ).toBe(true);
    expect(
      isSoulstreamInternalMcpServer({
        name: " soulstream-cogito ",
        type: "streamable_http",
      }),
    ).toBe(true);
  });

  it("excludes sse, stdio, unknown names, and missing names", () => {
    expect(isSoulstreamInternalMcpServer({ name: "soulstream", type: "sse" })).toBe(
      false,
    );
    expect(isSoulstreamInternalMcpServer({ name: "soulstream", type: "stdio" })).toBe(
      false,
    );
    expect(isSoulstreamInternalMcpServer({ name: "atom", type: "http" })).toBe(false);
    expect(isSoulstreamInternalMcpServer({ name: "   ", type: "http" })).toBe(false);
    expect(isSoulstreamInternalMcpServer({ type: "http" })).toBe(false);
  });
});

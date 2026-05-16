/**
 * BackendBadge resolveBackendStyle 순수 함수 검증.
 *
 * soul-ui vitest는 environment: "node" (vitest.config.ts) + include "*.test.ts" 만 수집.
 * 컴포넌트 렌더(jsdom + testing-library)는 본 패키지 인프라 외 — label/className 결정 로직만 분리하여 검증.
 */
import { describe, it, expect } from "vitest";
import { resolveBackendStyle, BACKEND_STYLE } from "./BackendBadge";

describe("resolveBackendStyle", () => {
  it("claude → 'Claude' label", () => {
    expect(resolveBackendStyle("claude").label).toBe("Claude");
  });

  it("codex → 'Codex' label", () => {
    expect(resolveBackendStyle("codex").label).toBe("Codex");
  });

  it("unknown backend → verbatim label, empty className", () => {
    const style = resolveBackendStyle("aider");
    expect(style.label).toBe("aider");
    expect(style.className).toBe("");
  });

  it("claude/codex 사전 스타일은 className 비어있지 않다", () => {
    expect(BACKEND_STYLE.claude.className).not.toBe("");
    expect(BACKEND_STYLE.codex.className).not.toBe("");
  });
});

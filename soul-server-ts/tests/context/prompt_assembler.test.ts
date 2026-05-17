/**
 * prompt_assembler 단위 회귀 — Python `service/prompt_assembler.py` + `context_builder.format_context_items`
 * 정본 정합.
 */

import { describe, expect, it } from "vitest";

import {
  assemblePrompt,
  formatContextItems,
  type ContextItem,
} from "../../src/context/prompt_assembler.js";

describe("formatContextItems (Python format_context_items 정합)", () => {
  it("string content는 그대로 + 닫힘 태그 패턴 이스케이프", () => {
    const out = formatContextItems([
      { key: "foo", content: "hello" },
      { key: "bar", content: "<other></other> raw" },
    ]);
    expect(out).toContain("<foo>\nhello\n</foo>");
    // </other>의 / 이스케이프
    expect(out).toContain("<bar>\n<other><\\/other> raw\n</bar>");
    expect(out.startsWith("<context>")).toBe(true);
    expect(out.endsWith("</context>")).toBe(true);
  });

  it("dict content는 json.dumps 직렬화 (Python ensure_ascii=False 등가)", () => {
    const out = formatContextItems([
      { key: "session", content: { id: "abc", name: "테스트" } },
    ]);
    // 한글 그대로 유지 + JSON
    expect(out).toContain('"name": "테스트"');
    expect(out).toContain('"id": "abc"');
  });

  it("invalid tag name (영문/숫자/_/- 외) → skip", () => {
    const out = formatContextItems([
      { key: "valid_key", content: "yes" },
      { key: "한글키", content: "skip" },  // 영문 외 → skip
      { key: "", content: "skip" },  // 빈 키 → skip
    ]);
    expect(out).toContain("<valid_key>\nyes\n</valid_key>");
    expect(out).not.toContain("한글키");
    expect(out).not.toContain("skip");
  });

  it("content가 null/undefined/빈 문자열 → skip", () => {
    const items: ContextItem[] = [
      { key: "a", content: null },
      { key: "b", content: undefined },
      { key: "c", content: "" },
      { key: "d", content: "ok" },
    ];
    const out = formatContextItems(items);
    expect(out).toBe("<context>\n<d>\nok\n</d>\n</context>");
  });

  it("모든 item invalid → 빈 문자열 (호출자가 prepend skip)", () => {
    expect(formatContextItems([{ key: "", content: "x" }])).toBe("");
    expect(formatContextItems([])).toBe("");
  });
});

describe("assemblePrompt (Python assemble_prompt 정합)", () => {
  it("context undefined → prompt 그대로", () => {
    expect(assemblePrompt("hello", undefined)).toBe("hello");
  });

  it("items 빈 배열 → prompt 그대로", () => {
    expect(assemblePrompt("hello", { items: [] })).toBe("hello");
  });

  it("items 있으면 XML 블록 + 두 줄 공백 + prompt", () => {
    const result = assemblePrompt("user request", {
      items: [{ key: "ctx", content: "value" }],
    });
    expect(result).toBe(
      "<context>\n<ctx>\nvalue\n</ctx>\n</context>\n\nuser request",
    );
  });
});

/**
 * prompt_assembler 단위 회귀 — Python `service/prompt_assembler.py` + `context_builder.format_context_items`
 * 정본 정합.
 */

import { describe, expect, it } from "vitest";

import {
  assemblePrompt,
  formatContextItems,
  formatContextItemsWithMaterial,
  type ContextItem,
} from "../../src/context/prompt_assembler.js";
import { createInputMaterialPart } from "../../src/context/input_material_parts.js";

describe("formatContextItems (Python `format_context_items` 정본 L72-85)", () => {
  it("string content는 그대로 — 이스케이프 *없음* (Python L83 정합)", () => {
    const out = formatContextItems([
      { key: "foo", content: "hello" },
      { key: "bar", content: "<other></other> raw" },
    ]);
    expect(out).toContain("<foo>\nhello\n</foo>");
    // Python format_context_items는 string에 이스케이프 안 함 — `</other>` 그대로
    expect(out).toContain("<bar>\n<other></other> raw\n</bar>");
    expect(out.startsWith("<context>")).toBe(true);
    expect(out.endsWith("</context>")).toBe(true);
  });

  it("dict content는 json.dumps(indent=2) 직렬화 (Python L81 정합)", () => {
    const out = formatContextItems([
      { key: "session", content: { id: "abc", name: "테스트" } },
    ]);
    // 한글 그대로 유지 + JSON + indent=2 (multi-line)
    expect(out).toContain('"name": "테스트"');
    expect(out).toContain('"id": "abc"');
    expect(out).toMatch(/\{\n {2}"/);  // indent=2 마커
  });

  it("invalid tag name (영문/숫자/_ 외) → '_'로 치환 (Python L78 `re.sub` 정합, skip 아님)", () => {
    const out = formatContextItems([
      { key: "valid_key", content: "yes" },
      { key: "한글키", content: "kept" },  // → "___" (3 underscores, 각 음절 1자 치환 X — 영문 외 코드포인트는 일괄 _)
      { key: "with-dash", content: "kept2" },  // '-' 도 영문/숫자/_ 외 → '_'로 치환
    ]);
    expect(out).toContain("<valid_key>\nyes\n</valid_key>");
    // 한글키 (3자) → 모두 영문/숫자/_ 외 → "___" (3개 underscore)
    expect(out).toContain("<___>\nkept\n</___>");
    // with-dash → with_dash
    expect(out).toContain("<with_dash>\nkept2\n</with_dash>");
  });

  it("key 자체가 빈 결과로 정규화되면 'item' 폴백 (Python L78 `or \"item\"`)", () => {
    const out = formatContextItems([{ key: "", content: "ok" }]);
    expect(out).toContain("<item>\nok\n</item>");
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

  it("모든 item 빈 content → 빈 문자열 (호출자가 prepend skip)", () => {
    expect(formatContextItems([{ key: "a", content: "" }])).toBe("");
    expect(formatContextItems([])).toBe("");
  });
});

describe("formatContextItemsWithMaterial", () => {
  it("keeps legacy serialization and partitions each visible character into framing or content", () => {
    const items: ContextItem[] = [
      { key: "with-dash", content: "hello 😀" },
      { key: "object", content: { value: 1 } },
      { key: "null", content: null },
      { key: "empty", content: "" },
    ];

    const result = formatContextItemsWithMaterial(items);

    expect(result.text).toBe(formatContextItems(items));
    expect(result.text).toContain("<with_dash>\nhello 😀\n</with_dash>");
    expect(result.parts.reduce((sum, part) => sum + (part.raw_chars_utf16 ?? 0), 0))
      .toBe(result.text.length);
    expect(result.parts).toContainEqual(expect.objectContaining({
      category: "soulstream_injection",
      source_key: "context/0/content",
      raw_chars_utf16: "hello 😀".length,
      approximate_tokens: 2,
      estimate_source: "derived_chars",
    }));
  });

  it("preserves repeated source occurrences and a stored zero estimate", () => {
    const source = createInputMaterialPart(
      "soulstream_injection",
      "source/atom/node-1/0",
      "same body",
      0,
    );
    const result = formatContextItemsWithMaterial(
      [
        { key: "first", content: "same body" },
        { key: "second", content: "same body" },
      ],
      [[source], [source]],
    );
    const contentParts = result.parts.filter((part) => part.category === "soulstream_injection");

    expect(contentParts.map((part) => part.source_key)).toEqual([
      "context/0/atom/source/atom/node-1/0",
      "context/1/atom/source/atom/node-1/0",
    ]);
    expect(contentParts.map((part) => part.approximate_tokens)).toEqual([0, 0]);
    expect(contentParts.map((part) => part.estimate_source)).toEqual(["manifest", "manifest"]);
    expect(result.parts.reduce((sum, part) => sum + (part.raw_chars_utf16 ?? 0), 0))
      .toBe(result.text.length);
  });

  it("prefers stored token estimates, including nonzero values, and derives only when absent", () => {
    expect(createInputMaterialPart("user_prompt", "stored-zero", "12345", 0)).toMatchObject({
      raw_chars_utf16: 5,
      approximate_tokens: 0,
      estimate_source: "manifest",
    });
    expect(createInputMaterialPart("user_prompt", "stored", "12345", 17)).toMatchObject({
      raw_chars_utf16: 5,
      approximate_tokens: 17,
      estimate_source: "manifest",
    });
    expect(createInputMaterialPart("user_prompt", "derived", "12345")).toMatchObject({
      raw_chars_utf16: 5,
      approximate_tokens: 2,
      estimate_source: "derived_chars",
    });
  });
});

describe("assemblePrompt (Python `assemble_prompt` 정본 L23-71)", () => {
  it("context undefined → prompt 그대로", () => {
    expect(assemblePrompt("hello", undefined)).toBe("hello");
  });

  it("items 빈 배열 → prompt 그대로", () => {
    expect(assemblePrompt("hello", { items: [] })).toBe("hello");
  });

  it("items 있으면 XML 블록 + 두 줄 공백 + prompt — *<context> 래퍼 없음* (Python L65 부분)", () => {
    // Python assemble_prompt는 *<context> 래퍼 없이* 개별 태그를 \\n으로 연결한다 (L65).
    const result = assemblePrompt("user request", {
      items: [{ key: "ctx", content: "value" }],
    });
    expect(result).toBe("<ctx>\nvalue\n</ctx>\n\nuser request");
  });

  it("invalid tag name → skip (Python L53 `TAG_NAME_RE.fullmatch` 정합 — 치환 아님)", () => {
    const result = assemblePrompt("u", {
      items: [
        { key: "valid", content: "ok" },
        { key: "한글", content: "skipped" },
      ],
    });
    expect(result).toBe("<valid>\nok\n</valid>\n\nu");
    expect(result).not.toContain("skipped");
  });

  it("string content → 이스케이프 적용 (Python L59 정합)", () => {
    const result = assemblePrompt("u", {
      items: [{ key: "ctx", content: "<other></other>" }],
    });
    expect(result).toContain("<other><\\/other>");
  });

  it("dict content → json.dumps *indent 없음* (Python L61 정합)", () => {
    const result = assemblePrompt("u", {
      items: [{ key: "data", content: { a: 1, b: "테스트" } }],
    });
    // indent 없음 — single-line JSON
    expect(result).toContain('<data>\n{"a":1,"b":"테스트"}\n</data>');
  });

  it("모든 item skip → prompt 그대로 (Python L67-68)", () => {
    const result = assemblePrompt("only prompt", {
      items: [
        { key: "한글", content: "skip" },
        { key: "valid", content: null },
      ],
    });
    expect(result).toBe("only prompt");
  });
});

import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  composeText,
  evaluate,
  initialState,
  reduce,
  renderParts,
  renderText,
  validateChatUiDocument,
} from "../src/index.js";
import type {
  ChatUiDocumentV1,
  NormalizedChatUiDocumentV1,
  Unit,
} from "../src/index.js";

function validDocument(input: unknown): NormalizedChatUiDocumentV1 {
  const result = validateChatUiDocument(input);
  if (!result.ok) {
    throw new Error(`문서 검증 실패: ${JSON.stringify(result.errors)}`);
  }
  return result.document;
}

function unit(dims: Record<string, number>, symbol: string, scale = 1): Unit {
  return { dims, symbol, scale };
}

describe("@soulstream/chat-ui 계약", () => {
  it("1. 단가와 수량을 계산하고 현재 수량 변경을 글과 결과에 함께 반영한다", () => {
    const doc = validDocument({
      schema_version: 1,
      units: {
        won: unit({ "currency:KRW": 1 }, "원"),
        wonPerItem: unit({ "currency:KRW": 1, count: -1 }, "원/개"),
        item: unit({ count: 1 }, "개"),
      },
      data: { unitPrice: { value: 120000, unit: "wonPerItem" } },
      fields: {
        quantity: {
          type: "number",
          initial: 3,
          min: 0,
          max: 10,
          step: 1,
          unit: "item",
        },
      },
      computed: {
        total: {
          op: "mul",
          args: [
            { op: "ref", ref: { data: "unitPrice" } },
            { op: "ref", ref: { field: "quantity" } },
          ],
        },
      },
      body: [
        {
          id: "totalLine",
          kind: "text",
          parts: ["합계 ", { value: { computed: "total" }, unit: "won" }],
        },
      ],
    });

    const start = initialState(doc);
    expect(evaluate(doc, start).computed.total).toEqual({
      type: "number",
      base: 360000,
      dims: { "currency:KRW": 1 },
    });
    expect(renderText(doc, start)).toBe("합계 360,000원");

    const updated = reduce(doc, start, { type: "set", field: "quantity", value: 4 });
    expect(evaluate(doc, updated).computed.total).toEqual({
      type: "number",
      base: 480000,
      dims: { "currency:KRW": 1 },
    });
    expect(renderText(doc, updated)).toBe("합계 480,000원");
  });

  it("2. 서로 다른 시간 단위를 기준 단위로 더하고 표시 단위를 바꾼다", () => {
    const doc = validDocument({
      schema_version: 1,
      units: {
        minutes: unit({ time: 1 }, "min", 60),
        hours: unit({ time: 1 }, "h", 3600),
      },
      data: {
        break: { value: 90, unit: "minutes" },
        work: { value: 1, unit: "hours" },
      },
      computed: {
        total: {
          op: "add",
          args: [
            { op: "ref", ref: { data: "break" } },
            { op: "ref", ref: { data: "work" } },
          ],
        },
      },
      body: [],
    });
    const state = initialState(doc);
    expect(evaluate(doc, state).computed.total).toEqual({
      type: "number",
      base: 9000,
      dims: { time: 1 },
    });
    expect(renderParts(doc, state, [{ value: { computed: "total" }, unit: "minutes" }]))
      .toBe("150 min");
    expect(renderParts(doc, state, [{ value: { computed: "total" }, unit: "hours" }]))
      .toBe("2.5 h");
    expect(renderParts(doc, state, [{ value: { computed: "total" }, unit: "minutes", digits: 1 }]))
      .toBe("150.0 min");
  });

  it("3. 서로 다른 통화 차원을 더하는 문서는 식 위치를 가리켜 거부한다", () => {
    const result = validateChatUiDocument({
      schema_version: 1,
      units: {
        krw: unit({ "currency:KRW": 1 }, "원"),
        usd: unit({ "currency:USD": 1 }, "$"),
      },
      data: {
        local: { value: 1, unit: "krw" },
        foreign: { value: 1, unit: "usd" },
      },
      computed: {
        total: {
          op: "add",
          args: [
            { op: "ref", ref: { data: "local" } },
            { op: "ref", ref: { data: "foreign" } },
          ],
        },
      },
      body: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("서로 다른 통화의 합이 허용되었습니다.");
    expect(result.errors.map(({ path }) => path)).toContain("computed.total.args[1]");
  });

  it("4. 0 나눗셈은 정해진 오류 글로 표시하고 독립 계산은 유지한다", () => {
    const doc = validDocument({
      schema_version: 1,
      units: { won: unit({ "currency:KRW": 1 }, "원") },
      computed: {
        broken: {
          op: "div",
          args: [
            { op: "const", value: 5, unit: "won" },
            { op: "const", value: 0, unit: "won" },
          ],
        },
        independent: { op: "const", value: 7, unit: "won" },
      },
      body: [],
    });
    const state = initialState(doc);

    expect(renderParts(doc, state, [{ value: { computed: "broken" } }]))
      .toBe("계산할 수 없음(0으로 나눌 수 없습니다)");
    expect(evaluate(doc, state).computed.independent).toEqual({
      type: "number",
      base: 7,
      dims: { "currency:KRW": 1 },
    });
  });

  it("5. 무차원 비율을 percent 형식으로 표시한다", () => {
    const doc = validDocument({
      schema_version: 1,
      units: { ratio: unit({}, "") },
      computed: { rate: { op: "const", value: 0.1, unit: "ratio" } },
      body: [],
    });

    expect(renderParts(doc, initialState(doc), [
      { value: { computed: "rate" }, format: "percent" },
    ])).toBe("10%");
  });

  it("6. 순환·누락 참조·미지 스키마·비유한 값·중복 id·특수 키를 거부한다", () => {
    const cyclic: unknown = {
      schema_version: 1,
      computed: {
        first: { op: "ref", ref: { computed: "second" } },
        second: { op: "ref", ref: { computed: "first" } },
      },
      body: [],
    };
    const missing: unknown = {
      schema_version: 1,
      computed: { absent: { op: "ref", ref: { field: "constructor" } } },
      body: [],
    };
    const unknownKind: unknown = {
      schema_version: 1,
      body: [{ id: "node", kind: "unknown", extra: true }],
    };
    const unknownKey: unknown = {
      schema_version: 1,
      title: "title",
      body: [],
    };
    (unknownKey as Record<string, unknown>).unexpected = true;
    const duplicateIds: unknown = {
      schema_version: 1,
      body: [
        { id: "same", kind: "text", parts: ["a"] },
        { id: "same", kind: "text", parts: ["b"] },
      ],
    };
    const protoKey = JSON.parse(
      '{"schema_version":1,"data":{"__proto__":{"value":1,"unit":"unit"}},"body":[]}',
    ) as unknown;

    for (const input of [
      cyclic,
      missing,
      unknownKind,
      unknownKey,
      duplicateIds,
      protoKey,
      { schema_version: 1, data: { "bad\n": { value: 1, unit: "unit" } }, body: [] },
      { schema_version: 1, data: { bad: { value: Number.NaN, unit: "unit" } }, body: [] },
      { schema_version: 1, data: { bad: { value: Number.POSITIVE_INFINITY, unit: "unit" } }, body: [] },
    ]) {
      expect(validateChatUiDocument(input).ok).toBe(false);
    }
  });

  it("7. 입력 상태는 범위와 step에 맞추고 잘못된 값은 같은 상태로 거부한다", () => {
    const doc = validDocument({
      schema_version: 1,
      units: { item: unit({ count: 1 }, "개") },
      fields: {
        amount: { type: "number", initial: 1, min: 0, max: 10, step: 2, unit: "item" },
        note: { type: "text", initial: "", maxLength: 2 },
      },
      body: [],
    });
    const start = initialState(doc);
    const clamped = reduce(doc, start, { type: "set", field: "amount", value: 100 });
    expect(clamped.values.amount).toBe(10);
    const stepped = reduce(doc, clamped, { type: "set", field: "amount", value: 5.7 });
    expect(stepped.values.amount).toBe(6);
    expect(reduce(doc, stepped, { type: "set", field: "amount", value: "6" as never }))
      .toBe(stepped);
    expect(reduce(doc, stepped, { type: "set", field: "amount", value: 6 })).toBe(stepped);
    expect(reduce(doc, stepped, { type: "reset" })).toEqual(start);
    expect(reduce(doc, start, { type: "set", field: "note", value: "😀😁x" }).values.note)
      .toBe("😀😁");
  });

  it("8. 조건이 참이 되는 때에만 숨긴 문장을 렌더한다", () => {
    const doc = validDocument({
      schema_version: 1,
      fields: { show: { type: "boolean", initial: false } },
      body: [
        { id: "always", kind: "text", parts: ["항상 표시"] },
        {
          id: "conditional",
          kind: "text",
          visibleWhen: { op: "ref", ref: { field: "show" } },
          parts: ["조건부 표시"],
        },
      ],
    });
    const start = initialState(doc);
    expect(renderText(doc, start)).toBe("항상 표시");
    const visible = reduce(doc, start, { type: "set", field: "show", value: true });
    expect(renderText(doc, visible)).toBe("항상 표시\n\n조건부 표시");
  });

  it("9. form은 현재 선택 label을 줄별로 만들고 parts가 있는 compose 버튼은 그 글만 만든다", () => {
    const doc = validDocument({
      schema_version: 1,
      fields: {
        plan: {
          type: "choice",
          initial: "pro",
          options: [
            { id: "basic", label: "기본" },
            { id: "pro", label: "전문가" },
          ],
        },
        period: {
          type: "choice",
          initial: "month",
          options: [
            { id: "month", label: "월간" },
            { id: "year", label: "연간" },
          ],
        },
        note: { type: "text", initial: "메모", maxLength: 20 },
      },
      body: [
        {
          id: "form",
          kind: "form",
          items: [
            { field: "plan", label: "요금제" },
            { field: "period", label: "기간" },
            { field: "note", label: "메모" },
          ],
          submitLabel: "입력창에 추가",
          action: { type: "compose" },
        },
        {
          id: "button",
          kind: "button",
          label: "요약 추가",
          action: {
            type: "compose",
            parts: ["선택: ", { value: { field: "plan" } }],
          },
        },
      ],
    });
    const state = initialState(doc);

    expect(composeText(doc, state, "form"))
      .toBe("요금제: 전문가\n기간: 월간\n메모: 메모");
    expect(composeText(doc, state, "button")).toBe("선택: 전문가");
  });

  it("10. 키 순서와 생략된 맵은 정규형과 정본 JSON에서 같은 결과를 낸다", () => {
    const left = validDocument(JSON.parse(
      '{"schema_version":1,"body":[{"id":"line","kind":"text","parts":["same"]}],"data":{},"units":{},"fields":{},"computed":{},"sources":{},"assumptions":[]}',
    ) as ChatUiDocumentV1);
    const right = validDocument(JSON.parse(
      '{"assumptions":[],"sources":{},"computed":{},"fields":{},"units":{},"data":{},"body":[{"parts":["same"],"kind":"text","id":"line"}],"schema_version":1}',
    ) as ChatUiDocumentV1);
    const omitted = validDocument({
      schema_version: 1,
      body: [{ id: "line", kind: "text", parts: ["same"] }],
    });

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(left).toEqual(omitted);
    expect(canonicalJson(left)).toBe(canonicalJson(omitted));
  });

  it("일반 텍스트 노드, 필드, 버튼, 출처와 가정을 문서 순서대로 렌더한다", () => {
    const doc = validDocument({
      schema_version: 1,
      title: "요약",
      units: { item: unit({ count: 1 }, "개") },
      fields: {
        quantity: { type: "number", initial: 2, min: 0, max: 5, step: 1, unit: "item" },
        done: { type: "boolean", initial: true },
      },
      sources: {
        basis: { type: "assumption", label: "기준" },
        report: { type: "external_link", label: "자료", url: "https://example.test/item" },
      },
      body: [
        { id: "heading", kind: "heading", level: 1, parts: ["시작"] },
        { id: "strong", kind: "text", parts: ["중요"], emphasis: "strong" },
        { id: "caption", kind: "caption", parts: ["부가"] },
        {
          id: "group",
          kind: "group",
          layout: "row",
          children: [
            { id: "left", kind: "text", parts: ["왼쪽"] },
            { id: "right", kind: "text", parts: ["오른쪽"] },
          ],
        },
        { id: "slider", kind: "slider", field: "quantity", label: "수량" },
        { id: "check", kind: "checkbox", field: "done", label: "완료" },
        { id: "confirm", kind: "button", label: "확인", action: { type: "copy" } },
        { id: "cancel", kind: "button", label: "취소", action: { type: "reset" } },
        { id: "entity", kind: "entity", label: "상세", details: [] },
        {
          id: "entityDetails",
          kind: "entity",
          label: "수량",
          details: ["값 ", { value: { field: "quantity" } }],
        },
        { id: "assumption", kind: "citation", source: "basis" },
        { id: "link", kind: "citation", source: "report" },
      ],
      assumptions: ["일정은 추정", "기준은 확인"],
    });

    expect(renderText(doc)).toBe([
      "**요약**",
      "**시작**",
      "**중요**",
      "부가",
      "왼쪽\n\n오른쪽",
      "수량: 2개",
      "완료: 예",
      "[확인] [취소]",
      "상세",
      "수량: 값 2개",
      "출처: 기준",
      "출처: [자료](https://example.test/item)",
      "가정: 일정은 추정; 기준은 확인",
    ].join("\n\n"));
  });

  it("UTF-8 크기와 노드·computed 상한을 검증 단계에서 거부한다", () => {
    const oversized = validateChatUiDocument({
      schema_version: 1,
      body: [],
      assumptions: ["한".repeat(44000)],
    });
    const tooManyNodes = validateChatUiDocument({
      schema_version: 1,
      body: Array.from({ length: 201 }, (_, index) => ({
        id: `node${index}`,
        kind: "text",
        parts: [],
      })),
    });
    const computed = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [
      `value${index}`,
      { op: "const", value: 1, unit: "ratio" },
    ]));
    const tooManyComputed = validateChatUiDocument({
      schema_version: 1,
      units: { ratio: unit({}, "") },
      computed,
      body: [],
    });

    expect(oversized.ok).toBe(false);
    expect(tooManyNodes.ok).toBe(false);
    expect(tooManyComputed.ok).toBe(false);
  });
});

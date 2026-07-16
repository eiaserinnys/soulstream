import { describe, expect, it } from "vitest";

import {
  errorResult,
  jsonResult,
  paginatedArrayResult,
} from "../../src/mcp/result.js";

describe("jsonResult", () => {
  it("text content와 structuredContent를 함께 노출", () => {
    const result = jsonResult({ foo: "bar", n: 42 });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ foo: "bar", n: 42 }, null, 2) },
    ]);
    expect(result.structuredContent).toEqual({ foo: "bar", n: 42 });
    expect(result.isError).toBeUndefined();
  });

  it("배열 응답도 그대로 직렬화", () => {
    const result = jsonResult([1, 2, 3]);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual([
      1, 2, 3,
    ]);
    expect(result.structuredContent).toEqual({ result: [1, 2, 3] });
  });

  it("원시값 응답은 structuredContent.result로 감싼다", () => {
    const result = jsonResult("ok");
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify("ok", null, 2) },
    ]);
    expect(result.structuredContent).toEqual({ result: "ok" });
  });
});

describe("paginatedArrayResult", () => {
  it("keeps the legacy array payload and adds structured pagination metadata", () => {
    const result = paginatedArrayResult(
      [1, 2],
      { total: 3, truncated: true, next_offset: 2 },
      "3건 중 2건 표시. offset=2로 계속 조회하세요.",
    );

    expect(result.content[0]).toEqual({
      type: "text",
      text: JSON.stringify([1, 2], null, 2),
    });
    expect(result.content[1]).toEqual({
      type: "text",
      text: "3건 중 2건 표시. offset=2로 계속 조회하세요.",
    });
    expect(result.structuredContent).toEqual({
      result: [1, 2],
      total: 3,
      truncated: true,
      next_offset: 2,
    });
  });
});

describe("errorResult", () => {
  it("isError true + content + structuredContent.error", () => {
    const result = errorResult("세션 없음");
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "세션 없음" }]);
    expect(result.structuredContent).toEqual({ error: "세션 없음" });
  });
});

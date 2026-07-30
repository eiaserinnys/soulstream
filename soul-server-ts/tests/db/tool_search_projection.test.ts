import { describe, expect, it } from "vitest";

import { extractSearchableText } from "../../src/db/event_persistence.js";
import {
  TOOL_SEARCHABLE_TEXT_MAX_CODE_POINTS,
} from "../../src/db/tool_search_projection.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";

describe("tool searchable text projection", () => {
  it("tool_start는 이름과 우선순위 핵심 인자를 제한된 투영으로 만든다", () => {
    expect(
      extractSearchableText({
        type: "tool_start",
        tool_name: "mcp/atom/search_cards",
        tool_input: {
          zeta: "후순위",
          options: {
            prompt: "검색 프롬프트",
            ignored: { too_deep: "제외" },
          },
          query: "가라앉은 배",
          path: "/workspace/project",
          rows: ["첫째", "둘째", "셋째", "넷째"],
        },
      } as unknown as SSEEventPayload),
    ).toBe(
      "tool: mcp/atom/search_cards query: 가라앉은 배 path: /workspace/project "
      + "options.prompt: 검색 프롬프트 rows[0]: 첫째 rows[1]: 둘째 rows[2]: 셋째 zeta: 후순위",
    );
  });

  it("JSON 문자열 입력을 파싱하고 실패 시에도 이름과 원문 앞부분을 남긴다", () => {
    expect(
      extractSearchableText({
        type: "tool_start",
        tool_name: "search",
        tool_input: '{"query":"needle","limit":3}',
      } as unknown as SSEEventPayload),
    ).toBe("tool: search query: needle limit: 3");

    expect(
      extractSearchableText({
        type: "tool_start",
        tool_name: "broken_json",
        tool_input: '{"query":',
      } as unknown as SSEEventPayload),
    ).toBe('tool: broken_json input: {"query":');
  });

  it("tool_result는 이름과 결과 앞부분만 남기고 코드포인트 경계를 지킨다", () => {
    const searchable = extractSearchableText({
      type: "tool_result",
      tool_name: "mcp/atom/search_cards",
      result: `찾았다 ${"가".repeat(2_000)}🔨`,
    } as unknown as SSEEventPayload);

    expect(searchable.startsWith("tool: mcp/atom/search_cards result: 찾았다 ")).toBe(true);
    expect(Array.from(searchable)).toHaveLength(
      TOOL_SEARCHABLE_TEXT_MAX_CODE_POINTS,
    );
    expect(searchable.charCodeAt(searchable.length - 1)).not.toBeGreaterThanOrEqual(
      0xd800,
    );
  });

  it("비정상적으로 긴 이름도 제한하며 두 이벤트가 항상 이름을 남긴다", () => {
    const longName = `tool-${"나".repeat(500)}`;
    const start = extractSearchableText({
      type: "tool_start",
      tool_name: longName,
      tool_input: {},
    } as unknown as SSEEventPayload);
    const result = extractSearchableText({
      type: "tool_result",
      tool_name: "",
      result: "",
    } as unknown as SSEEventPayload);

    expect(Array.from(start)).toHaveLength(134);
    expect(start.startsWith("tool: tool-")).toBe(true);
    expect(result).toBe("tool: unknown_tool result:");
  });
});

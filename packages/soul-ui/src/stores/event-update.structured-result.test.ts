import { describe, expect, it } from "vitest";

import type { ToolNode, ToolResultEvent } from "../shared/types";
import { applyUpdate, TRUNCATE_THRESHOLD } from "./event-update";
import { createProcessingContext, makeNode } from "./processing-context";

const RESULT_CASES = [
  { label: "object", present: true, value: { ok: true, count: 2 }, text: '{\n  "ok": true,\n  "count": 2\n}' },
  { label: "array", present: true, value: [{ type: "text", text: "kept", extra: 7 }], text: '[\n  {\n    "type": "text",\n    "text": "kept",\n    "extra": 7\n  }\n]' },
  { label: "string", present: true, value: "already text", text: "already text" },
  { label: "number scalar", present: true, value: 0, text: "0" },
  { label: "boolean scalar", present: true, value: false, text: "false" },
  { label: "null", present: true, value: null, text: "null" },
  { label: "missing", present: false, value: undefined, text: "" },
] as const;

describe("applyUpdate structured tool results", () => {
  it.each(RESULT_CASES)("normalizes $label once at the display boundary", ({ present, value, text }) => {
    const ctx = createProcessingContext();
    const root = makeNode("root", "session", "");
    const tool = makeNode("tool-1", "tool", "", { toolUseId: "tool-r57" }) as ToolNode;
    ctx.nodeMap.set("tool-r57", tool);
    const event = {
      type: "tool_result",
      timestamp: 2,
      tool_name: "mcp/soulstream/list_session_events",
      is_error: false,
      tool_use_id: "tool-r57",
      ...(present ? { result: value } : {}),
    } as unknown as ToolResultEvent;

    expect(applyUpdate(event, 368, ctx, root)).toBe(true);
    expect(tool.toolResult).toBe(text);
    expect(tool.completed).toBe(true);
  });

  it("keeps every content-block field and points a long preview at the raw event", () => {
    const ctx = createProcessingContext();
    const root = makeNode("root", "session", "");
    const tool = makeNode("tool-1", "tool", "", { toolUseId: "tool-r57" }) as ToolNode;
    ctx.nodeMap.set("tool-r57", tool);
    const result = [{
      type: "text",
      text: "x".repeat(TRUNCATE_THRESHOLD + 100),
      annotations: { source: "fixture" },
    }];
    const fullText = JSON.stringify(result, null, 2);

    applyUpdate({
      type: "tool_result",
      timestamp: 2,
      tool_name: "mcp/soulstream/list_session_events",
      result,
      is_error: false,
      tool_use_id: "tool-r57",
    } as unknown as ToolResultEvent, 368, ctx, root);

    expect(tool.toolResult).toBe(fullText.slice(0, TRUNCATE_THRESHOLD));
    expect(tool.isTruncated).toBe(true);
    expect(tool.fullContentEventId).toBe(368);
    expect(fullText).toContain('"annotations"');
  });
});

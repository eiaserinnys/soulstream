import type { CallToolResult } from "@soulstream/mcp-contract";
import { executeMcpTool } from "../../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../../src/mcp/types.js";
type McpRequestContext = { callerSessionId?: string; principal?: { authority: string; source: string; displayName: string } };
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoardRoundtripHarness } from "../../../soul-server-ts/tests/mcp/board-roundtrip-harness.js";

const context: McpRequestContext = { callerSessionId: "header-session" };
const external: McpRequestContext = { ...context, principal: { authority: "external", source: "llm", displayName: "External" } };
const move = { board_item_id: "markdown:doc-1", folder_id: "00000000-0000-4000-8000-000000000001", idempotency_key: "move" };
const view = { folder_id: "00000000-0000-4000-8000-000000000001", html: "<p>새 뷰</p>", idempotency_key: "create-view" };
const patch = { custom_view_id: "cv-1", expected_revision: 1, html: "<p>after</p>", idempotency_key: "patch-view" };
// Each existing handler's explicit errors and each required production branch is listed here.
const cases: readonly [string, string, Record<string, unknown>, boolean?, McpRequestContext?][] = [["external read", "get_custom_view", { custom_view_id: "cv-1" }, false, external],
["external view mutation", "create_custom_view", { ...view, caller_session_id: "argument-session" }, false, external]];

describe("folder-board-custom-view MCP roundtrip", () => {
  let h: Awaited<ReturnType<typeof createBoardRoundtripHarness>>;
  beforeAll(async () => { h = await createBoardRoundtripHarness(); }, 60_000);
  afterAll(async () => { await h?.cleanup(); });
  async function call(name: string, args: Record<string, unknown>) { const value: CallToolResult = await executeMcpTool(h.executionOptions as unknown as McpHostOptions, name as never, args, { principal: "external", callerSessionId: null, nodeId: "test-node" }); const { content, structuredContent, isError, ...rest } = value; return { ...rest, content, ...(structuredContent === undefined ? {} : { structuredContent }), ...(isError === undefined ? {} : { isError }) }; }
  async function roundtrip(name: string, args: Record<string, unknown>, requestContext = context, fails = false) {
    await h.seed(); const next = await call(name, args);
    expect(next.isError === true, name).toBe(fails);
    expect(serializeResult(name, next)).toMatchSnapshot(name);
    expect(JSON.stringify(maskEvents(name, h.events))).toMatchSnapshot(`${name} events`);
    return next;
  }
  it.each(cases)("preserves %s", async (_label, name, args, fails = false, requestContext = context) => {
    await roundtrip(name, args, requestContext, fails);
  });
});

// Exact relative paths in parsed text/structuredContent/events; no blanket UUID masking.
const randomIdPaths: Record<string, readonly string[]> = {
  // CatalogBoardItemService.createMarkdownDocument: documentId=randomUUID(); BoardYjs model repeats it.
  create_markdown_document: ["document.id", "boardItem.id", "boardItem.itemId"],
};
export function mask(tool: string, value: unknown, path: string[] = []): unknown {
  if (randomIdPaths[tool]?.includes(path.join("."))) return "<random-id>";
  if (Array.isArray(value)) return value.map((child, index) => mask(tool, child, [...path, String(index)]));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    /_at$|At$/.test(key) && child !== null ? "<time>" : mask(tool, child, [...path, key]) ]));
}
// The generated document ID is also the single created board-delta key and its id/itemId.
// Exact event path: [0].board_items_delta.<boardItem.id>.{id,itemId}; no other keys are masked.
function maskEvents(tool: string, events: unknown[]): unknown {
  if (tool !== "create_markdown_document") return mask(tool, events);
  return events.map((event, index) => {
    const record = event as { board_items_delta: Record<string, { id: string; itemId: string }> };
    if (index !== 0) return mask(tool, event);
    expect(Object.keys(record.board_items_delta)).toHaveLength(1);
    const [item] = Object.values(record.board_items_delta);
    return mask(tool, { ...record, board_items_delta: { "<random-board-id>": { ...item, id: "<random-id>", itemId: "<random-id>" } } });
  });
}
function serializeResult(tool: string, result: unknown): string {
  const value = result as { content: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
  return JSON.stringify({ ...value, content: value.content.map(item => {
    if (item.type !== "text" || value.isError) return item;
    let parsed: unknown; try { parsed = JSON.parse(item.text!); } catch { return item; }
    expect(item.text).toBe(JSON.stringify(parsed, null, 2));
    return { ...item, text: JSON.stringify(mask(tool, parsed), null, 2) };
  }), ...(value.structuredContent === undefined ? {} : { structuredContent: mask(tool, value.structuredContent) }) }, null, 2);
}

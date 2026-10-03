import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoardRoundtripHarness } from "./board-roundtrip-harness.js";
import type { McpRequestContext } from "../../src/mcp/request_context.js";

const context: McpRequestContext = { callerSessionId: "header-session" };
const external: McpRequestContext = { ...context, principal: { authority: "external", source: "llm", displayName: "External" } };
const move = { board_item_id: "markdown:doc-1", folder_id: "00000000-0000-4000-8000-000000000001", idempotency_key: "move" };
const view = { folder_id: "00000000-0000-4000-8000-000000000001", html: "<p>새 뷰</p>", idempotency_key: "create-view" };
const patch = { custom_view_id: "cv-1", expected_revision: 1, html: "<p>after</p>", idempotency_key: "patch-view" };
// Each existing handler's explicit errors and each required production branch is listed here.
const cases: readonly [string, string, Record<string, unknown>, boolean?, McpRequestContext?][] = [
  ["folders", "list_folders", {}],
  ["mixed browse", "browse_folder", { folder_id: "00000000-0000-4000-8000-000000000001" }],
  ["browse cursors", "browse_folder", { folder_id: "00000000-0000-4000-8000-000000000001", session_cursor: 1, session_limit: 1, cursor: 1, limit: 2 }],
  ["browse archived", "browse_folder", { folder_id: "00000000-0000-4000-8000-000000000001", include_archived: true }],
  ["browse missing", "browse_folder", { folder_id: "missing" }, true],
  ["move folder", "move_folder", { folder_id: "00000000-0000-4000-8000-000000000003", parent_folder_id: "00000000-0000-4000-8000-000000000002" }],
  ["move root", "move_folder", { folder_id: "00000000-0000-4000-8000-000000000003", parent_folder_id: null }],
  ["move system", "move_folder", { folder_id: "claude" }, true],
  ["move missing", "move_folder", { folder_id: "missing" }, true],
  ["archive folder", "delete_folder", { folder_id: "00000000-0000-4000-8000-000000000003" }],
  ["archive system", "delete_folder", { folder_id: "claude" }, true],
  ["archive missing", "delete_folder", { folder_id: "missing" }, true],
  ["move sessions", "move_sessions_to_folder", { session_ids: ["header-session"], folder_id: "00000000-0000-4000-8000-000000000002" }],
  ["remove sessions", "move_sessions_to_folder", { session_ids: ["header-session"] }],
  ["update snapped position", "update_board_item_position", { board_item_id: "markdown:doc-1", x: 13, y: -31 }],
  ["position missing", "update_board_item_position", { board_item_id: "missing", x: 1, y: 2 }, true],
  ["same folder position", "move_board_item_to_folder", { ...move, x: 13, y: 31 }],
  ["same folder unchanged", "move_board_item_to_folder", move],
  ["partial x", "move_board_item_to_folder", { ...move, x: 1 }, true],
  ["partial y", "move_board_item_to_folder", { ...move, y: 1 }, true],
  ["enroll generated", "move_board_item_to_folder", { ...move, board_item_id: "session:generated" }],
  ["move missing folder", "move_board_item_to_folder", { ...move, folder_id: "missing" }, true],
  ["move missing item", "move_board_item_to_folder", { ...move, board_item_id: "missing" }, true],
  ["move missing session", "move_board_item_to_folder", { ...move, board_item_id: "session:missing" }, true],
  ["move reference", "move_board_item_to_folder", { ...move, board_item_id: "ref:doc-1" }, true],
  ["move frame", "move_board_item_to_folder", { ...move, board_item_id: "frame:frame-1" }, true],
  ["create document positioned", "create_markdown_document", { folder_id: "00000000-0000-4000-8000-000000000001", title: "문서", body: "본문", x: 13, y: 31 }],
  ["create document automatic position", "create_markdown_document", { folder_id: "00000000-0000-4000-8000-000000000001", title: "문서" }],
  ["get document", "get_markdown_document", { document_id: "doc-1" }],
  ["get document missing", "get_markdown_document", { document_id: "missing" }, true],
  ["update document", "update_markdown_document", { document_id: "doc-1", expected_version: 1, title: "수정", body: "새 본문" }],
  ["document stale version", "update_markdown_document", { document_id: "doc-1", expected_version: 999, body: "새 본문" }, true],
  ["document empty update", "update_markdown_document", { document_id: "doc-1", expected_version: 1 }, true],
  ["update document missing", "update_markdown_document", { document_id: "missing", expected_version: 1, body: "본문" }, true],
  ["update orphan document", "update_markdown_document", { document_id: "orphan", expected_version: 1, body: "본문" }, true],
  ["delete document", "delete_markdown_document", { document_id: "doc-1" }],
  ["delete missing document", "delete_markdown_document", { document_id: "missing" }],
  ["delete orphan document", "delete_markdown_document", { document_id: "orphan" }, true],
  ["get prompt", "get_folder_system_prompt", { folder_id: "00000000-0000-4000-8000-000000000001" }],
  ["get missing prompt", "get_folder_system_prompt", { folder_id: "missing" }, true],
  ["set prompt", "set_folder_system_prompt", { folder_id: "00000000-0000-4000-8000-000000000001", system_prompt: "새 지침" }],
  ["clear prompt", "set_folder_system_prompt", { folder_id: "00000000-0000-4000-8000-000000000001" }],
  ["set missing prompt", "set_folder_system_prompt", { folder_id: "missing", system_prompt: "지침" }, true],
  ["search matches", "search_folder_items", { folder_id: "00000000-0000-4000-8000-000000000001", query: "찾을" }],
  ["search none", "search_folder_items", { folder_id: "00000000-0000-4000-8000-000000000001", query: "없을 단어" }],
  ["search blank", "search_folder_items", { folder_id: "00000000-0000-4000-8000-000000000001", query: " " }, true],
  ["search missing folder", "search_folder_items", { folder_id: "missing", query: "문서" }, true],
  ["create view", "create_custom_view", view],
  ["create missing folder", "create_custom_view", { ...view, folder_id: "missing" }, true],
  ["patch view", "patch_custom_view", patch],
  ["patch null title", "patch_custom_view", { ...patch, title: null }],
  ["patch missing", "patch_custom_view", { ...patch, custom_view_id: "missing" }, true],
  ["get view", "get_custom_view", { custom_view_id: "cv-1" }],
  ["get missing view returns null", "get_custom_view", { custom_view_id: "missing" }],
  ["list views", "list_custom_views", { folder_id: "00000000-0000-4000-8000-000000000001" }],
  ["list missing folder", "list_custom_views", { folder_id: "missing" }, true],
  ["external read", "get_custom_view", { custom_view_id: "cv-1" }, false, external],
  ["external view mutation", "create_custom_view", { ...view, caller_session_id: "argument-session" }, false, external],
  ["internal no session", "create_custom_view", view, true, {}],
  ["explicit trimmed session", "create_custom_view", { ...view, caller_session_id: " argument-session " }],
];

describe("folder-board-custom-view MCP roundtrip", () => {
  let h: Awaited<ReturnType<typeof createBoardRoundtripHarness>>;
  beforeAll(async () => { h = await createBoardRoundtripHarness(); }, 60_000);
  afterAll(async () => { await h?.cleanup(); });
  async function roundtrip(name: string, args: Record<string, unknown>, requestContext = context, fails = false) {
    await h.seed(); const next = await h.call(name, args, requestContext);
    expect(next.isError === true, name).toBe(fails);
    expect(serializeResult(name, next)).toMatchSnapshot(name);
    expect(JSON.stringify(maskEvents(name, h.events))).toMatchSnapshot(`${name} events`);
    return next;
  }
  it.each(cases)("preserves %s", async (_label, name, args, fails = false, requestContext = context) => {
    await roundtrip(name, args, requestContext, fails);
  });
  it.each(["browse_folder", "search_folder_items"])("uses the owning node's profile for %s", async name => {
    await h.seed(); h.distinguishRemoteNames(true);
    const args = { folder_id: "00000000-0000-4000-8000-000000000001", ...(name === "search_folder_items" ? { query: "원격" } : {}) };
    try {
      const next = await h.call(name, args, context);
      const items = (result: Awaited<ReturnType<typeof h.call>>) => (result.structuredContent as { items: { agent_session_id?: string; agent?: { id: string; name: string } }[] }).items;
      expect(items(next).find(item => item.agent_session_id === "remote")?.agent?.name).toBe("다른 노드 이름");
      if (name === "browse_folder") expect(items(next).find(item => item.agent_session_id === "header-session")?.agent?.name).toBe("로젤린");
    } finally { h.distinguishRemoteNames(false); }
  });
  it("queries agent profiles once per node within each tool call", async () => {
    await h.seed(); h.listAgentProfiles.mockClear();
    const args = { folder_id: "00000000-0000-4000-8000-000000000001" };
    const first = await h.call("browse_folder", args, context);
    expect(first.isError).not.toBe(true);
    const sessions = (first.structuredContent as { items: { type: string; node_id?: string }[] }).items.filter(item => item.type === "session");
    expect(sessions.filter(item => item.node_id === "test-node").length).toBeGreaterThan(1);
    expect(h.listAgentProfiles.mock.calls.map(([nodeId]) => nodeId).sort()).toEqual(["other-node", "test-node"]);
    await h.call("browse_folder", args, context);
    expect(h.listAgentProfiles.mock.calls.map(([nodeId]) => nodeId).sort()).toEqual(["other-node", "other-node", "test-node", "test-node"]);
  });
  it("records the legacy revision conflict and reports the actual revision on the new path", async () => {
    const args = { ...patch, expected_revision: 999 };
    await h.seed(); const next = await h.call("patch_custom_view", args, context);
    const actualMessage = "custom view revision conflict for cv-1: expected 999, actual 1";
    expect(next.isError).toBe(true);
    expect(next.content).toEqual([{ type: "text", text: actualMessage }]);
    expect(next.structuredContent).toEqual({ error: actualMessage });
  });
  it("includes archived views only when requested", async () => {
    await h.seed(); await h.h.sql`UPDATE board_custom_views SET archived=TRUE WHERE id='cv-1'`;
    {
      const hidden = await h.call("browse_folder", { folder_id: "00000000-0000-4000-8000-000000000001" }, context);
      const shown = await h.call("browse_folder", { folder_id: "00000000-0000-4000-8000-000000000001", include_archived: true }, context);
      const items = (result: typeof hidden) => (result.structuredContent as { items: { type: string; archived: boolean }[] }).items;
      expect(items(hidden).some(item => item.type === "custom_view")).toBe(false);
      expect(items(shown).find(item => item.type === "custom_view")).toMatchObject({ archived: true });
    }
  });
  it("records the legacy targetFolderId failure and actually moves on the new path", async () => {
    const args = { ...move, folder_id: "00000000-0000-4000-8000-000000000002", x: 13, y: 31 };
    await h.seed(); const next = await h.call("move_board_item_to_folder", args, context);
    expect(next.isError).not.toBe(true);
    expect(next.structuredContent).toMatchObject({ ok: true, board_item: { id: "markdown:doc-1", folderId: "00000000-0000-4000-8000-000000000002", x: 20, y: 40 }, idempotency_key: "move" });
    expect(await h.projectionHost.getBoardItemById("markdown:doc-1")).toMatchObject({ folderId: "00000000-0000-4000-8000-000000000002", x: 20, y: 40 });
  });
  it("creates once for the same custom-view key and emits no duplicate notification", async () => {
    const run = async () => {
      await h.seed(); const first = await h.call("create_custom_view", view, context);
      const count = h.events.length;
      const second = await h.call("create_custom_view", view, context);
      expect(second.structuredContent).toHaveProperty("idempotent", true);
      expect(h.events).toHaveLength(count);
      return [first, second];
    };
    const next = await run();
    next.forEach((result, index) => {
      expect(serializeResult("create_custom_view", result)).toMatchSnapshot(`create_custom_view ${index}`);
    });
  });
  it("preserves the 2000-item search scan boundary", async () => {
    const run = async () => {
      await h.seed();
      await h.h.sql`INSERT INTO markdown_documents(id,title,body,version)
        SELECT 'bulk-'||n,'bulk','검색',1 FROM generate_series(1,2001) n`;
      await h.h.sql`INSERT INTO board_items(id,folder_id,item_type,item_id,x,y,metadata)
        SELECT 'markdown:bulk-'||n,'00000000-0000-4000-8000-000000000001','markdown','bulk-'||n,0,0,'{}'::jsonb FROM generate_series(1,2001) n`;
      return h.call("search_folder_items", { folder_id: "00000000-0000-4000-8000-000000000001", query: "검색", limit: 80 }, context);
    };
    const next = await run();
    expect(serializeResult("search_folder_items", next)).toMatchSnapshot("search_folder_items");
    expect(next.structuredContent).toMatchObject({ truncated: true, scan_limit: 2000, scanned_items: 2000, page: { limit: 50 } });
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
describe("board result masking", () => {
  it("masks only document generation fields and time", () => {
    const value = { document: { id: "generated", createdAt: "now" }, boardItem: { id: "markdown:generated", itemId: "generated" }, existingId: "keep" };
    expect(mask("create_markdown_document", value)).toEqual({ document: { id: "<random-id>", createdAt: "<time>" }, boardItem: { id: "<random-id>", itemId: "<random-id>" }, existingId: "keep" });
    expect(mask("get_markdown_document", value)).toEqual({ ...value, document: { id: "generated", createdAt: "<time>" } });
  });
});

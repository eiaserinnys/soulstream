import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoardRoundtripHarness } from "./board-roundtrip-harness.js";

// Reuse the SDK -> worker forward -> orch host -> disposable PG/Y.Doc roundtrip.
const source = "00000000-0000-4000-8000-000000000001";
const target = "00000000-0000-4000-8000-000000000002";
const context = { callerSessionId: "header-session" };
type CatalogEvent = {
  type: string;
  folders: { id: string; version: number; status: string; archived: boolean }[];
  sessions_delta: Record<string, { folderId: string | null; displayName: string | null }>;
  board_items_delta: Record<string, { id: string; folderId: string; x: number; y: number }>;
};

describe("public board notification integrity", () => {
  let h: Awaited<ReturnType<typeof createBoardRoundtripHarness>>;
  beforeAll(async () => { h = await createBoardRoundtripHarness(); }, 60_000);
  afterAll(async () => { await h?.cleanup(); });
  const deltas = () => h.events.filter(event => (event as CatalogEvent).type === "catalog_updated") as CatalogEvent[];
  async function call(name: string, args: Record<string, unknown>) {
    const result = await h.call(name, args, context);
    expect(result.isError).not.toBe(true);
    return result;
  }
  async function assertFolders(event: CatalogEvent) {
    const rows = await h.h.sql`SELECT id, version, status, archived FROM folders ORDER BY id`;
    expect(event.folders.map(({ id, version, status, archived }) => ({ id, version, status, archived }))
      .sort((a, b) => a.id.localeCompare(b.id))).toEqual(rows);
    expect(event).not.toHaveProperty("nodeId");
  }

  it("keeps folder edit versions after a public document creation", async () => {
    await h.seed();
    const result = await call("create_markdown_document", { folder_id: source, title: "알림 문서", body: "본문" });
    expect(deltas()).toHaveLength(1);
    await assertFolders(deltas()[0]!);
    const item = (result.structuredContent as { boardItem: { id: string } }).boardItem;
    expect(deltas()[0]!.board_items_delta[item.id]).toMatchObject({ folderId: source });
  });

  it.each(["move_sessions_to_folder", "move_board_item_to_folder"])("publishes descendants and the root board item once through %s", async name => {
    await h.seed();
    await h.h.sql`INSERT INTO sessions(session_id,node_id,status,agent_id,display_name,folder_id,caller_session_id)
      VALUES('child','test-node','running','roselin','자식',${source},'header-session'),
      ('grandchild','test-node','running','roselin','손자',${source},'child')`;
    await call(name, name === "move_sessions_to_folder"
      ? { session_ids: ["header-session"], folder_id: target }
      : { board_item_id: "session:header-session", folder_id: target, x: 13, y: 31, idempotency_key: "tree-move" });
    expect(deltas()).toHaveLength(1);
    await assertFolders(deltas()[0]!);
    expect(Object.keys(deltas()[0]!.sessions_delta).sort()).toEqual(["child", "grandchild", "header-session"]);
    for (const assignment of Object.values(deltas()[0]!.sessions_delta)) expect(assignment.folderId).toBe(target);
    expect(deltas()[0]!.board_items_delta["session:header-session"]).toMatchObject({ folderId: target,
      ...(name === "move_board_item_to_folder" ? { x: 20, y: 40 } : {}) });
    h.events.length = 0;
    await call(name, name === "move_sessions_to_folder"
      ? { session_ids: ["header-session"], folder_id: target }
      : { board_item_id: "session:header-session", folder_id: target, x: 13, y: 31, idempotency_key: "tree-move" });
    expect(deltas()).toHaveLength(0);
  });

  it("publishes one notification per committed root and zero for no changes", async () => {
    await h.seed();
    await call("move_sessions_to_folder", { session_ids: ["header-session", "argument-session"], folder_id: target });
    expect(deltas()).toHaveLength(2);
    expect(deltas().map(event => Object.keys(event.board_items_delta))).toEqual([
      ["session:header-session"], ["session:argument-session"],
    ]);
    h.events.length = 0;
    await call("move_sessions_to_folder", { session_ids: ["header-session", "argument-session"], folder_id: target });
    await call("move_sessions_to_folder", { session_ids: [], folder_id: target });
    expect(deltas()).toHaveLength(0);
  });

  it("enrolls a generated session once and retains same-folder position updates", async () => {
    await h.seed();
    const args = { board_item_id: "session:generated", folder_id: source, x: 13, y: 31, idempotency_key: "enroll" };
    await call("move_board_item_to_folder", args);
    expect(deltas()).toHaveLength(1);
    await assertFolders(deltas()[0]!);
    expect(deltas()[0]!.board_items_delta["session:generated"]).toMatchObject({ folderId: source, x: 20, y: 40 });
    h.events.length = 0;
    await call("move_board_item_to_folder", { ...args, x: 51, y: 71, idempotency_key: "position" });
    expect(deltas()).toHaveLength(1);
    expect(deltas()[0]!.board_items_delta["session:generated"]).toMatchObject({ x: 60, y: 80 });
    h.events.length = 0;
    await call("move_board_item_to_folder", { ...args, x: 51, y: 71, idempotency_key: "position" });
    expect(deltas()).toHaveLength(0);
  });

  it.each(["tree", "child-only", "primary-only"])("commits a real null detach once and skips repeated writes and notifications (%s)", async state => {
    await h.seed();
    const root = state === "child-only" ? "generated" : "header-session";
    await h.h.sql`INSERT INTO sessions(session_id,node_id,status,agent_id,folder_id,caller_session_id)
      VALUES('child','test-node','running','roselin',${state === "primary-only" ? null : source},${root})`;
    if (state !== "tree") await h.h.sql`UPDATE sessions SET folder_id=NULL WHERE session_id=${root}`;
    h.sessionMoveCommit.mockClear();
    const args = { session_ids: [root] };
    const first = await call("move_sessions_to_folder", args);
    expect(h.sessionMoveCommit).toHaveBeenCalledOnce();
    expect(deltas()).toHaveLength(1);
    await assertFolders(deltas()[0]!);
    expect(Object.keys(deltas()[0]!.sessions_delta).sort()).toEqual(["child", root].sort());
    for (const assignment of Object.values(deltas()[0]!.sessions_delta)) expect(assignment.folderId).toBeNull();
    const assignments = await h.h.sql`SELECT session_id,folder_id,xmin::text FROM sessions WHERE session_id IN (${root},'child') ORDER BY session_id`;
    expect(assignments.every(row => row.folder_id === null)).toBe(true);
    expect(await h.h.sql`SELECT id FROM board_items WHERE item_type='session' AND membership_kind='primary' AND item_id IN (${root},'child')`).toEqual([]);
    const documents = await h.h.sql`SELECT name,revision FROM board_yjs_documents ORDER BY name`;
    h.events.length = 0;
    h.sessionMoveCommit.mockClear();
    expect(await call("move_sessions_to_folder", args)).toEqual(first);
    expect(h.sessionMoveCommit).not.toHaveBeenCalled();
    expect(deltas()).toHaveLength(0);
    expect(await h.h.sql`SELECT session_id,folder_id,xmin::text FROM sessions WHERE session_id IN (${root},'child') ORDER BY session_id`).toEqual(assignments);
    expect(await h.h.sql`SELECT name,revision FROM board_yjs_documents ORDER BY name`).toEqual(documents);
  });

  it("retains non-session moves and the separate custom-view event without replay notifications", async () => {
    await h.seed();
    await call("move_board_item_to_folder", { board_item_id: "markdown:doc-1", folder_id: target, idempotency_key: "document-move" });
    expect(deltas()).toHaveLength(1);
    await assertFolders(deltas()[0]!);
    expect(deltas()[0]!.board_items_delta["markdown:doc-1"]).toMatchObject({ folderId: target });
    h.events.length = 0;
    const args = { folder_id: source, title: "알림 뷰", html: "<p>뷰</p>", idempotency_key: "notify-view" };
    await call("create_custom_view", args);
    expect(deltas()).toHaveLength(1);
    await assertFolders(deltas()[0]!);
    expect(h.events).toHaveLength(2);
    expect(h.events[1]).toMatchObject({ type: "custom_view_updated", customViewId: expect.any(String), revision: 1, nodeId: "test-node" });
    h.events.length = 0;
    await call("create_custom_view", args);
    expect(h.events).toHaveLength(0);
  });
});

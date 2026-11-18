import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { readSessionConversation } from "../src/session/session_conversation_projection.js";

describe("session conversation payload projection", () => {
  let db: FullSchemaPostgresHarness;
  const sessionId = "slim-session-projection";

  beforeAll(async () => {
    db = await createFullSchemaPostgresHarness();
    await db.sql`INSERT INTO folders(id,name) VALUES ('folder','Folder')`;
    await db.sql`INSERT INTO sessions(session_id,folder_id,model_preset) VALUES (${sessionId},'folder','sol')`;
  }, 60_000);
  afterAll(async () => { await db?.cleanup(); });

  it("matches the projection of full payloads through hidden, active and completed turns", async () => {
    const large = "내용".repeat(50_000);
    const events: Array<[string, Record<string, unknown>]> = [
      ["user_message", { text: "keepalive", purpose: "cache_keepalive", input_id: "hidden" }],
      ["tool_start", { tool_name: "hidden tool", input_id: "hidden", tool_input: { large } }],
      ["assistant_message", { content: "hidden answer", input_id: "hidden" }],
      ["complete", { result: large }],
      ["tool_start", { tool_name: "hidden after complete", preparedInputId: "hidden", tool_input: { large } }],
      ["user_message", { text: "질문", caller_info: { source: "browser" }, input_id: "visible" }],
      ["assistant_message", { content: "답변" }],
      ["tool_start", { tool_name: "Read", input_id: "visible", tool_input: { large } }],
      ["tool_result", { result: large }],
      ["tool_start", { tool_name: "Write", input_id: "visible", tool_input: { large } }],
      ["complete", { result: large }],
    ];
    const slimSql = createFolderContentSqlAdapter(db.sql as never);
    for (const [index, [type, payload]] of events.entries()) {
      await db.sql`INSERT INTO events(session_id,id,event_type,payload,created_at)
        VALUES (${sessionId}, ${index + 1}, ${type}, ${db.sql.json(payload as never)}, '2026-11-18T00:00:00Z')`;
      if (![2, 5, 8, 9, 10, 11].includes(index + 1)) continue;
      const rows = await db.sql`SELECT id,event_type,payload,created_at FROM events
        WHERE session_id=${sessionId} ORDER BY id`;
      const fullSql = Object.assign(async () => rows, {
        json: (value: unknown) => value,
        array: (value: unknown) => value,
        unsafe: (value: string) => value,
      }) as unknown as Parameters<typeof readSessionConversation>[0];
      const full = await readSessionConversation(fullSql, sessionId, null, "agent");
      const slim = await readSessionConversation(slimSql, sessionId, null, "agent");
      expect(slim).toEqual(full);
      if (index + 1 === 2) expect(slim.items).toEqual([]);
      if (index + 1 === 5) expect(slim).toMatchObject({ busy: false, tool: null });
      if (index + 1 === 8) expect(slim).toMatchObject({ busy: true, tool: "Read" });
      if (index + 1 === 9) expect(slim).toMatchObject({ busy: true, tool: null });
      if (index + 1 === 10) expect(slim).toMatchObject({ busy: true, tool: "Write" });
      if (index + 1 === 11) expect(slim).toMatchObject({ busy: false, tool: null });
    }
  }, 60_000);
});

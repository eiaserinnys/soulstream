import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { registerFolderRoutes } from "../src/folders/folder_routes.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";

describe("card progress over PostgreSQL and HTTP", () => {
  let h: FullSchemaPostgresHarness;
  const folderId = randomUUID(), cardId = randomUUID(), milestoneId = randomUUID();
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    h = await createFullSchemaPostgresHarness();
    await h.sql`INSERT INTO folders(id,name) VALUES (${folderId},'경과')`;
    await h.sql`INSERT INTO sessions(session_id,folder_id) VALUES ('assignee',${folderId}),('previous',${folderId})`;
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,assignee_kind,assignee_session_id)
      VALUES (${cardId},${folderId},'a','카드','session','assignee')`;
    await h.sql`INSERT INTO folder_operations(id,folder_id,target_kind,target_id,operation_type,actor_session_id,payload_json,created_at)
      VALUES (${milestoneId},${folderId},'card',${cardId},'update_card_now','previous',
        ${h.sql.json({ text: "작업 중", turn: "agent", ask: "검토" })},'2026-01-01T00:02:00Z')`;
    for (const [session, start, response, complete, base] of [
      ["previous", 1, 2, 3, 0], ["assignee", 1, 2, 3, 3], ["assignee", 4, 5, 6, 6],
    ] as const) {
      const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
      await h.sql`INSERT INTO events(session_id,id,event_type,payload,created_at) VALUES
        (${session},${start},'user_message',${h.sql.json({ text: "진행" })},${at(base)}),
        (${session},${response},'assistant_message',${h.sql.json({ content: `경과 ${base}` })},${at(base + 1)}),
        (${session},${complete},'complete',${h.sql.json({})},${at(base + 2)})`;
    }
    const cards = new CardControlPlaneService(createFolderContentSqlAdapter(h.sql as unknown as LivePostgresSql), { appendEventTx: async () => 0 });
    app = Fastify();
    registerFolderRoutes(app, {
      nodeCredentials: null,
      provider: { listFolders: () => [{ id: folderId }], listSessionAssignments: () => ({}) },
      accessProvider: { resolveAccess: () => ({ restricted: true, allowedFolderIds: [folderId] }) },
      resolveDashboardUserId: () => "test@example.com", cardServiceProvider: async () => cards,
      authBearerToken: "service-test", environment: "production",
    });
  }, 60_000);
  afterAll(async () => { await app?.close(); await h?.cleanup(); });

  it("returns completed assignee turns grouped by operation and exposes the same milestone id in detail", async () => {
    const progress = await app.inject(`/api/cards/${cardId}/progress`);
    expect(progress.statusCode).toBe(200);
    const body = progress.json();
    expect(body.cardId).toBe(cardId);
    expect(body.sessionIds.sort()).toEqual(["assignee", "previous"]);
    expect(body.bundles).toEqual([{ milestone: {
      id: milestoneId, at: "2026-01-01T00:02:00.000Z", text: "작업 중", ask: "검토", turn: "agent",
    }, entries: [
      { sessionId: "previous", eventId: 3, startedAt: "2026-01-01T00:00:00.000Z", at: "2026-01-01T00:02:00.000Z", text: "경과 0", truncated: false },
      { sessionId: "assignee", eventId: 3, startedAt: "2026-01-01T00:03:00.000Z", at: "2026-01-01T00:05:00.000Z", text: "경과 3", truncated: false },
      { sessionId: "assignee", eventId: 6, startedAt: "2026-01-01T00:06:00.000Z", at: "2026-01-01T00:08:00.000Z", text: "경과 6", truncated: false },
    ] }]);
    const detail = await app.inject(`/api/cards/${cardId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().nowHistory[0]).toMatchObject({ id: milestoneId, text: "작업 중" });
  }, 60_000);
});

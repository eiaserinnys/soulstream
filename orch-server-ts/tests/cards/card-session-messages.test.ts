import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerCardRoutes, cardRouteAuthRequirements } from "../../src/cards/card_routes.js";
import { readCardSessionMessages } from "../../src/cards/card_session_messages.js";
import type { CardDetail } from "../../src/cards/card_operations.js";
import type { SqlClient } from "../../src/cards/control_plane/card_types.js";
import { intervenePayload } from "../../src/session/session_action_command_payloads.js";
import { readSessionConversation } from "../../src/session/session_conversation_projection.js";
import type { FolderRouteOptions } from "../../src/folders/folder_routes.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

type EventRow = { id: number; event_type: string; payload: Record<string, unknown> | null; created_at: Date };

function sqlWithEvents(rows: EventRow[]) {
  const statements: string[] = [];
  const sql = Object.assign(async (strings: TemplateStringsArray) => {
    const statement = strings.join("?");
    statements.push(statement);
    return statement.includes("FROM events") ? rows : [];
  }, { json: (value: unknown) => value }) as unknown as SqlClient;
  return { sql, statements };
}

function detailOf(card: Record<string, unknown>, sessions: Array<Record<string, unknown>> = []) {
  return { card, sessions } as unknown as CardDetail;
}

type ConversationData = {
  assets?: Array<{ id: string; original_name: string; mime_type: string }>;
  uploads?: Array<{ upload: { path: string; name: string; mime: string; assetId?: string } }>;
  nodeId?: string | null;
};

function sqlWithConversation(rows: EventRow[], data: ConversationData = {}) {
  const statements: string[] = [];
  const sql = Object.assign(async (strings: TemplateStringsArray) => {
    const statement = strings.join("?");
    statements.push(statement);
    if (statement.includes("FROM events")) return rows;
    if (statement.includes("FROM file_assets")) return data.assets ?? [];
    if (statement.includes("jsonb_array_elements(uploads)")) return data.uploads ?? [];
    if (statement.includes("FROM sessions")) return data.nodeId ? [{ node_id: data.nodeId }] : [];
    return [];
  }, { json: (value: unknown) => value }) as unknown as SqlClient;
  return { sql, statements };
}

const events: EventRow[] = [
  { id: 1, event_type: "user_message", payload: { text: "카드 앱에 탭을 붙여 주세요." }, created_at: new Date("2026-11-07T10:00:00Z") },
  { id: 2, event_type: "tool_start", payload: { tool_name: "read" }, created_at: new Date("2026-11-07T10:00:01Z") },
  { id: 3, event_type: "assistant_message", payload: { content: "확인했습니다." }, created_at: new Date("2026-11-07T10:00:02Z") },
  { id: 4, event_type: "complete", payload: {}, created_at: new Date("2026-11-07T10:00:03Z") },
];

it("projects the linked session conversation with the card agent label", async () => {
  const { sql, statements } = sqlWithEvents(events);
  const result = await readCardSessionMessages(sql, detailOf(
    { assignee_session_id: "session-1", assignee_agent_id: "roselin" },
    [{ session_id: "session-1", display_name: "서소영", agent_id: "seosoyoung" }],
  ));
  expect(result).toMatchObject({ sessionId: "session-1", session: { sessionId: "session-1", displayName: "서소영" }, busy: false, tool: null });
  expect(statements.some(statement => statement.includes("file_assets"))).toBe(false);
  expect(statements.some(statement => statement.includes("jsonb_array_elements(uploads)"))).toBe(false);
  expect(result.items).toEqual([
    expect.objectContaining({ id: "1", kind: "user", role: "user", author: "사용자", text: "카드 앱에 탭을 붙여 주세요." }),
    expect.objectContaining({ id: "3", kind: "assistant", role: "assistant", author: "서소영", text: "확인했습니다." }),
  ]);
  expect(result.items[0]?.at).toBe("2026-11-07T10:00:00.000Z");
});

it("falls back to the card assignee agent id when the session row has no name", async () => {
  const { sql } = sqlWithEvents(events);
  const result = await readCardSessionMessages(sql, detailOf(
    { assignee_session_id: "session-1", assignee_agent_id: "roselin" },
    [{ session_id: "session-1", display_name: null, agent_id: null }],
  ));
  expect(result.items.at(-1)).toMatchObject({ author: "roselin" });
});

it("returns an empty state when the card has no linked session and clamps the limit to the newest items", async () => {
  const empty = await readCardSessionMessages(sqlWithEvents(events).sql, detailOf({ assignee_session_id: null }, []));
  expect(empty).toEqual({ sessionId: null, session: null, busy: false, tool: null, items: [] });

  const limited = await readCardSessionMessages(sqlWithEvents(events).sql, detailOf(
    { assignee_session_id: "session-1" },
    [{ session_id: "session-1", display_name: "담당" }],
  ), { limit: 1 });
  expect(limited.items.map(item => item.id)).toEqual(["3"]);

  const clamped = await readCardSessionMessages(sqlWithEvents(events).sql, detailOf(
    { assignee_session_id: "session-1" },
    [{ session_id: "session-1", display_name: "담당" }],
  ), { limit: 9999 });
  expect(clamped.items).toHaveLength(2);
});

it("rejects a session that is not linked to the card", async () => {
  await expect(readCardSessionMessages(sqlWithEvents(events).sql, detailOf(
    { assignee_session_id: "session-1" },
    [{ session_id: "session-1" }],
  ), { sessionId: "session-2" })).rejects.toMatchObject({ statusCode: 422, message: "카드에 연결된 세션이 아닙니다." });
});

it("resolves attachment ids through file asset metadata", async () => {
  const rows: EventRow[] = [
    { id: 1, event_type: "user_message", payload: { text: "", attachment_ids: ["asset-1"] }, created_at: new Date("2026-11-07T10:00:00Z") },
  ];
  const { sql } = sqlWithConversation(rows, {
    assets: [{ id: "asset-1", original_name: "사진.png", mime_type: "image/png" }],
  });
  const result = await readSessionConversation(sql, "session-1", { session_id: "session-1", node_id: "node-1" }, null);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.text).toBe("");
  expect(result.items[0]?.attachments).toEqual([{ id: "asset-1", name: "사진.png", mime: "image/png" }]);
});

it("keeps legacy paths readable through the session node and raw path", async () => {
  const rawPath = "/data/sessions/session-1/2026-11-07T10-00-00.000Z-photo.png";
  const rows: EventRow[] = [
    { id: 1, event_type: "user_message", payload: { text: "", attachment_paths: [rawPath] }, created_at: new Date("2026-11-07T10:00:00Z") },
  ];
  const { sql, statements } = sqlWithConversation(rows);
  const result = await readSessionConversation(sql, "session-1", { session_id: "session-1", node_id: "node-1" }, null);
  expect(result.items[0]?.attachments).toEqual([{ id: `path:node-1:${rawPath}`, name: "photo.png", mime: "image/png" }]);
  expect(statements.some(statement => statement.includes("FROM sessions"))).toBe(false);
});

it("uses the saved asset id for legacy paths recorded by a conversation receipt", async () => {
  const rawPath = "/data/sessions/session-1/2026-11-07T10-00-00.000Z-photo.png";
  const rows: EventRow[] = [
    { id: 1, event_type: "user_message", payload: { text: "", attachment_paths: [rawPath] }, created_at: new Date("2026-11-07T10:00:00Z") },
  ];
  const { sql } = sqlWithConversation(rows, {
    uploads: [{ upload: { path: rawPath, name: "photo.png", mime: "image/png", assetId: "asset-9" } }],
  });
  const result = await readSessionConversation(sql, "session-1", { session_id: "session-1", node_id: "node-1" }, null);
  expect(result.items[0]?.attachments).toEqual([{ id: "asset-9", name: "photo.png", mime: "image/png" }]);
});

it("dedupes inline attachment paths against their paired ids without a receipt", async () => {
  const rawPath = "/data/sessions/s1/a.png";
  const rows: EventRow[] = [
    {
      id: 1,
      event_type: "user_message",
      payload: { text: "", attachment_ids: ["asset-1"], attachment_paths: [rawPath] },
      created_at: new Date("2026-11-07T10:00:00Z"),
    },
  ];
  const { sql } = sqlWithConversation(rows, {
    assets: [{ id: "asset-1", original_name: "사진.png", mime_type: "image/png" }],
  });
  const result = await readSessionConversation(sql, "session-1", { session_id: "session-1", node_id: "node-1" }, null);
  expect(result.items[0]?.attachments).toEqual([{ id: "asset-1", name: "사진.png", mime: "image/png" }]);
});

it("falls back to the sessions table for the node id when the session row omits it", async () => {
  const rawPath = "/data/sessions/session-1/a.png";
  const rows: EventRow[] = [
    { id: 1, event_type: "user_message", payload: { text: "", attachment_paths: [rawPath] }, created_at: new Date("2026-11-07T10:00:00Z") },
  ];
  const { sql } = sqlWithConversation(rows, { nodeId: "node-2" });
  const result = await readSessionConversation(sql, "session-1", { session_id: "session-1" }, null);
  expect(result.items[0]?.attachments?.[0]?.id).toBe(`path:node-2:${rawPath}`);
});

it("accepts inline attachments without text and rejects oversized or malformed ones", () => {
  const file = { name: "a.png", mime: "image/png", data_base64: "aGVsbG8=" };
  expect(intervenePayload("sess-1", { attachments: [file] })).toMatchObject({
    ok: true, value: { type: "intervene", agentSessionId: "sess-1", text: "", inline_attachments: [file] },
  });
  expect(intervenePayload("sess-1", { text: "보세요", attachments: [file] })).toMatchObject({
    ok: true, value: { text: "보세요", inline_attachments: [file] },
  });
  expect(intervenePayload("sess-1", { attachments: [] })).toEqual({ ok: false, message: "text is required" });
  expect(intervenePayload("sess-1", { attachments: Array.from({ length: 11 }, () => file) }))
    .toEqual({ ok: false, message: "attachments must be an array of at most 10 items" });
  expect(intervenePayload("sess-1", { attachments: [{ ...file, data_base64: "not base64!" }] }))
    .toEqual({ ok: false, message: "attachment data_base64 must be valid base64" });
  expect(intervenePayload("sess-1", { attachments: [{ ...file, name: " " }] }))
    .toEqual({ ok: false, message: "attachment name must be a non-empty string" });
  expect(intervenePayload("sess-1", { text: "x", attachments: "a.png" }))
    .toEqual({ ok: false, message: "attachments must be an array of at most 10 items" });
});

function setup(user: string | null, allowedFolderIds = ["source"], override: Partial<FolderRouteOptions> = {}) {
  const card = { id: "card", folder_id: "source", version: 1, assignee_session_id: "assignee-session" };
  const sessions = [{ session_id: "assignee-session", display_name: "담당" }];
  const messages = { sessionId: "assignee-session", session: null, busy: false, tool: null, items: [] };
  const getCard = vi.fn(async () => ({ card, sessions }));
  const getCardSessionMessages = vi.fn(async () => messages);
  const send = vi.fn(async () => ({ status: 202, body: { accepted: true } }));
  const app = Fastify(); apps.push(app);
  registerCardRoutes(app, {
    provider: { listFolders: () => [{ id: "source" }, { id: "target" }] },
    accessProvider: { resolveAccess: () => ({ restricted: true, allowedFolderIds }) },
    resolveDashboardUserId: () => user,
    cardServiceProvider: async () => ({ getCard, getCardSessionMessages }),
    sendCardSessionMessage: send,
    authBearerToken: "service-token", environment: "production",
    ...override,
  } as unknown as FolderRouteOptions);
  return { app, getCard, getCardSessionMessages, send, messages };
}

it("serves the card conversation of the linked session", async () => {
  const { app, getCardSessionMessages, messages } = setup("owner@example.test");
  const response = await app.inject({ method: "GET", url: "/api/cards/card/messages?sessionId=assignee-session&limit=5" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(messages);
  expect(getCardSessionMessages).toHaveBeenCalledWith("card", { sessionId: "assignee-session", limit: "5" });
});

it("checks folder access and the card before reading messages", async () => {
  const denied = setup("owner@example.test", ["target"]);
  expect((await denied.app.inject({ method: "GET", url: "/api/cards/card/messages" })).statusCode).toBe(403);
  expect(denied.getCardSessionMessages).not.toHaveBeenCalled();

  const missing = setup("owner@example.test");
  missing.getCard.mockResolvedValueOnce(null as never);
  const response = await missing.app.inject({ method: "GET", url: "/api/cards/card/messages" });
  expect(response.statusCode).toBe(404);
  expect(response.json()).toMatchObject({ detail: { error: { code: "CARD_NOT_FOUND" } } });
  expect(missing.getCardSessionMessages).not.toHaveBeenCalled();
});

it("sends a message to the card session for a dashboard user", async () => {
  const { app, send } = setup("owner@example.test");
  const response = await app.inject({ method: "POST", url: "/api/cards/card/messages", payload: { text: " 이어서 진행해 주세요. ", idempotencyKey: "key-1" } });
  expect(response.statusCode).toBe(202);
  expect(response.json()).toEqual({ ok: true, sessionId: "assignee-session", delivery: { accepted: true } });
  expect(send).toHaveBeenCalledWith(expect.anything(), "assignee-session", { text: "이어서 진행해 주세요.", delivery_id: "key-1" });
});

it("carries the idempotency key into the intervention delivery id", () => {
  const parsed = intervenePayload("assignee-session", { text: "안녕하세요", delivery_id: "key-1" });
  expect(parsed).toMatchObject({ ok: true, value: { type: "intervene", agentSessionId: "assignee-session", text: "안녕하세요", delivery_id: "key-1" } });
});

it("forwards a failed delivery status unchanged", async () => {
  const send = vi.fn(async () => ({ status: 409, body: { error: { code: "SESSION_NOT_RUNNING" } } }));
  const { app } = setup("owner@example.test", ["source"], { sendCardSessionMessage: send });
  const response = await app.inject({ method: "POST", url: "/api/cards/card/messages", payload: { text: "안녕하세요" } });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ error: { code: "SESSION_NOT_RUNNING" } });
});

it("rejects a message to a session that is not linked to the card", async () => {
  const { app, send } = setup("owner@example.test");
  const response = await app.inject({ method: "POST", url: "/api/cards/card/messages", payload: { sessionId: "other-session", text: "안녕하세요" } });
  expect(response.statusCode).toBe(422);
  expect(response.json()).toMatchObject({ detail: { error: { code: "INVALID_CARD_REQUEST", message: "메시지를 보낼 카드 연결 세션이 없습니다." } } });
  expect(send).not.toHaveBeenCalled();
});

it("rejects an empty message body after trimming", async () => {
  const { app, send } = setup("owner@example.test");
  const response = await app.inject({ method: "POST", url: "/api/cards/card/messages", payload: { text: "   " } });
  expect(response.statusCode).toBe(422);
  expect(response.json()).toMatchObject({ detail: { error: { message: "메시지 내용을 입력하십시오." } } });
  expect(send).not.toHaveBeenCalled();
});

it("forwards inline attachments with an empty text and keeps the trimmed text otherwise", async () => {
  const attachments = [{ name: "a.png", mime: "image/png", data_base64: "aGVsbG8=" }];
  const withoutText = setup("owner@example.test");
  const empty = await withoutText.app.inject({
    method: "POST", url: "/api/cards/card/messages", payload: { text: "   ", attachments },
  });
  expect(empty.statusCode).toBe(202);
  expect(withoutText.send).toHaveBeenCalledWith(expect.anything(), "assignee-session", { text: "", attachments });

  const withText = setup("owner@example.test");
  const response = await withText.app.inject({
    method: "POST", url: "/api/cards/card/messages", payload: { text: " 이 사진 봐 주세요 ", attachments },
  });
  expect(response.statusCode).toBe(202);
  expect(withText.send).toHaveBeenCalledWith(expect.anything(), "assignee-session", {
    text: "이 사진 봐 주세요", attachments,
  });
});

it("rejects more than ten inline attachments before delivery", async () => {
  const { app, send } = setup("owner@example.test");
  const response = await app.inject({
    method: "POST", url: "/api/cards/card/messages",
    payload: { attachments: Array.from({ length: 11 }, () => ({ name: "a.png", mime: "image/png", data_base64: "aGVsbG8=" })) },
  });
  expect(response.statusCode).toBe(422);
  expect(send).not.toHaveBeenCalled();
});

it("reports a missing delivery wiring and refuses agent actors", async () => {
  const unwired = setup("owner@example.test", ["source"], { sendCardSessionMessage: undefined });
  expect((await unwired.app.inject({ method: "POST", url: "/api/cards/card/messages", payload: { text: "안녕하세요" } })).statusCode).toBe(503);

  const agent = setup("owner@example.test");
  const response = await agent.app.inject({
    method: "POST", url: "/api/cards/card/messages", payload: { text: "안녕하세요" },
    headers: { authorization: "Bearer service-token", "x-soulstream-agent-session-id": "agent-session" },
  });
  expect(response.statusCode).toBe(403);
  expect(agent.send).not.toHaveBeenCalled();
});

it("declares auth for the message routes", () => {
  expect(cardRouteAuthRequirements["GET /api/cards/:id/messages"]).toBe(true);
  expect(cardRouteAuthRequirements["POST /api/cards/:id/messages"]).toBe(true);
});

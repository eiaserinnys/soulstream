import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";
import { registerCardRoutes } from "../src/cards/card_routes.js";
import type { FolderRouteOptions } from "../src/folders/folder_routes.js";

describe("card comments HTTP, storage, and delivery", () => {
  let h: PagePostgresHarness;
  let cards: CardControlPlaneService;
  let dispatcher: CardDispatcher;
  let sequence = 0;
  const messages = vi.fn(async (_sessionId: string, _text: string) => {});
  const warnings = vi.fn();
  const notify = vi.fn(async () => {});
  const cardUpdated = vi.fn(async () => {});
  const human = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director@example.com" };
  const key = () => `comment-test:${++sequence}`;

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`INSERT INTO folders(id,name) VALUES ('comment-folder','커멘트')`;
    const sql = createBoardYjsSqlAdapter(h.liveSql);
    cards = new CardControlPlaneService(sql, {
      appendEventTx: async (tx, p) => {
        const rows = await tx<{ id: number }[]>`SELECT event_append(${p.sessionId},${p.eventType},${p.payload},${p.searchableText},${p.createdAt},${p.dedupeKey ?? null}) AS id`;
        return rows[0]!.id;
      },
    }, { emitCardUpdated: cardUpdated, emitFolderUpdated: async () => {} }, change => dispatcher.acceptMutation(change));
    dispatcher = new CardDispatcher({
      repository: new CardDispatchRepository(async () => sql),
      cards: async () => cards,
      resolveTarget: () => ({ nodeId: "eiaserinnys", agentId: "roselin", modelPreset: null, available: true, reason: null }),
      launch: async () => {},
      sendMessage: messages,
      notify,
      warn: warnings,
    });
  }, 60_000);

  afterAll(async () => { await dispatcher?.drain(); await h?.cleanup(); });

  beforeEach(async () => {
    await dispatcher.drain();
    await h.sql`DELETE FROM card_comments`;
    await h.sql`DELETE FROM folder_operations`;
    await h.sql`DELETE FROM cards`;
    await h.sql`DELETE FROM sessions`;
    messages.mockClear();
    warnings.mockClear();
    notify.mockClear();
    cardUpdated.mockClear();
  });

  async function makeCard(title = "커멘트 대상") {
    const created = await cards.createCard({ ...human, folderId: "comment-folder", title, request: "요청", idempotencyKey: key() });
    await dispatcher.drain();
    return created.operation.target_id;
  }

  function app() {
    const server = Fastify();
    registerCardRoutes(server, {
      provider: { listFolders: () => [{ id: "comment-folder" }], listSessionAssignments: () => ({}) },
      accessProvider: { resolveAccess: () => ({ restricted: false, allowedFolderIds: [] }) },
      resolveDashboardUserId: () => human.actorUserId,
      cardServiceProvider: async () => cards,
      authBearerToken: "service-test",
      environment: "production",
    } as unknown as FolderRouteOptions);
    return server;
  }

  it.each([
    { target: "assigned", actor: "self", kind: "spoken", expected: 0 },
    { target: "assigned", actor: "self", kind: "comment", expected: 1 },
    { target: "assigned", actor: "other", kind: "spoken", expected: 1 },
    { target: "fallback", actor: "self", kind: "spoken", expected: 0 },
    { target: "fallback", actor: "self", kind: "comment", expected: 1 },
    { target: "fallback", actor: "other", kind: "spoken", expected: 1 },
  ] as const)("delivers $actor $kind to $target exactly $expected times, including idempotent replay", async ({ target, actor, kind, expected }) => {
    const cardId = await makeCard();
    await h.sql`INSERT INTO sessions(session_id,folder_id,card_id,status) VALUES
      ('target-session','comment-folder',${cardId},'running'),('other-session','comment-folder',${cardId},'running')`;
    if (target === "assigned") {
      await h.sql`UPDATE cards SET assignee_kind='session',assignee_session_id='target-session' WHERE id=${cardId}`;
    } else {
      await h.sql`INSERT INTO folder_operations(id,folder_id,target_kind,target_id,operation_type,actor_kind,payload_json)
        VALUES ('dispatch-target','comment-folder','card',${cardId},'dispatch_card','system','{"session_id":"target-session"}')`;
    }
    cardUpdated.mockClear();
    const input = {
      actorKind: kind === "spoken" ? "agent" as const : "user" as const,
      actorSessionId: actor === "self" ? "target-session" : "other-session",
      cardId, body: "옮겨 적은 사용자 지시", kind, idempotencyKey: key(),
    };
    const posted = await cards.addComment(input);
    const retried = await cards.addComment(input);
    expect(retried.id).toBe(posted.id);
    await dispatcher.drain();
    expect(messages).toHaveBeenCalledTimes(expected);
    if (expected) expect(messages).toHaveBeenCalledWith("target-session", "[카드 커멘트] 「커멘트 대상」\n옮겨 적은 사용자 지시");
    const detail = (await cards.getCard(cardId))!;
    expect(detail.comments).toEqual([expect.objectContaining({
      id: posted.id, author_kind: "user", session_id: input.actorSessionId, kind, body: input.body,
      delivered_at: expected ? expect.any(Date) : null,
    })]);
    expect(detail.card.latest_activity).toMatchObject({ kind: "instruction", body: input.body });
    expect(cardUpdated).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });

  it("stores a dashboard comment, returns it in get_card, and delivers once to the assigned session", async () => {
    const cardId = await makeCard();
    await h.sql`INSERT INTO sessions(session_id,folder_id,card_id,status) VALUES ('assigned-session','comment-folder',${cardId},'running')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_session_id='assigned-session' WHERE id=${cardId}`;
    const server = app();
    try {
      const request = { body: "고정된 지시", idempotencyKey: key() };
      const posted = await server.inject({ method: "POST", url: `/api/cards/${cardId}/comments`, payload: request });
      expect(posted.statusCode).toBe(201);
      expect(posted.json()).toMatchObject({ cardId, authorKind: "user", authorId: human.actorUserId, sessionId: null, kind: "comment", body: "고정된 지시" });
      const retried = await server.inject({ method: "POST", url: `/api/cards/${cardId}/comments`, payload: request });
      expect(retried.statusCode).toBe(201);
      expect(retried.json().id).toBe(posted.json().id);
      await dispatcher.drain();
      expect(messages).toHaveBeenCalledTimes(1);
      expect(messages).toHaveBeenCalledWith("assigned-session", "[카드 커멘트] 「커멘트 대상」\n고정된 지시");
      const detail = await server.inject(`/api/cards/${cardId}`);
      expect(detail.json().comments).toEqual([expect.objectContaining({ body: "고정된 지시", authorKind: "user", kind: "comment" })]);
      const stored = await h.sql<{ delivered_at: Date | null }[]>`SELECT delivered_at FROM card_comments WHERE card_id=${cardId}`;
      expect(stored[0]!.delivered_at).toBeInstanceOf(Date);
      const comments = await h.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM card_comments WHERE card_id=${cardId}`;
      expect(comments[0]!.count).toBe(1);
    } finally { await server.close(); }
  });

  it("falls back to the latest dispatch_card session when no assignee session is set", async () => {
    const cardId = await makeCard("최근 dispatch");
    await h.sql`INSERT INTO sessions(session_id,folder_id,card_id,status) VALUES
      ('older-dispatch','comment-folder',${cardId},'completed'),('latest-dispatch','comment-folder',${cardId},'running')`;
    await h.sql`INSERT INTO folder_operations(id,folder_id,target_kind,target_id,operation_type,actor_kind,payload_json,created_at)
      VALUES ('dispatch-old','comment-folder','card',${cardId},'dispatch_card','system','{"session_id":"older-dispatch"}',NOW()-INTERVAL '1 minute'),
             ('dispatch-new','comment-folder','card',${cardId},'dispatch_card','system','{"session_id":"latest-dispatch"}',NOW())`;
    const server = app();
    try {
      const posted = await server.inject({ method: "POST", url: `/api/cards/${cardId}/comments`, payload: { body: "이어 진행", idempotencyKey: key() } });
      expect(posted.statusCode).toBe(201);
      await dispatcher.drain();
      expect(messages).toHaveBeenCalledTimes(1);
      expect(messages).toHaveBeenCalledWith("latest-dispatch", "[카드 커멘트] 「최근 dispatch」\n이어 진행");
      const stored = await h.sql<{ delivered_at: Date | null }[]>`SELECT delivered_at FROM card_comments WHERE card_id=${cardId}`;
      expect(stored[0]!.delivered_at).toBeInstanceOf(Date);
    } finally { await server.close(); }
  });

  it("keeps delivery null when there is no assigned or dispatched session", async () => {
    const cardId = await makeCard("미담당");
    const server = app();
    try {
      const posted = await server.inject({ method: "POST", url: `/api/cards/${cardId}/comments`, payload: { body: "보존할 지시", idempotencyKey: key() } });
      expect(posted.statusCode).toBe(201);
      await dispatcher.drain();
      expect(messages).not.toHaveBeenCalled();
      const stored = await h.sql<{ delivered_at: Date | null }[]>`SELECT delivered_at FROM card_comments WHERE card_id=${cardId}`;
      expect(stored[0]!.delivered_at).toBeNull();
      expect((await cards.getCard(cardId))!.comments).toHaveLength(1);
    } finally { await server.close(); }
  });

  it("leaves delivered_at null when sending the comment fails", async () => {
    const cardId = await makeCard("전달 실패");
    await h.sql`INSERT INTO sessions(session_id,folder_id,card_id,status) VALUES ('failed-session','comment-folder',${cardId},'running')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_session_id='failed-session' WHERE id=${cardId}`;
    messages.mockRejectedValueOnce(new Error("delivery failed"));
    const server = app();
    try {
      const posted = await server.inject({ method: "POST", url: `/api/cards/${cardId}/comments`, payload: { body: "보낼 지시", idempotencyKey: key() } });
      expect(posted.statusCode).toBe(201);
      await dispatcher.drain();
      expect(messages).toHaveBeenCalledTimes(1);
      expect(warnings).toHaveBeenCalledOnce();
      const stored = await h.sql<{ delivered_at: Date | null }[]>`SELECT delivered_at FROM card_comments WHERE card_id=${cardId}`;
      expect(stored[0]!.delivered_at).toBeNull();
    } finally { await server.close(); }
  });

  it("stores trusted MCP comments as spoken user direction tied to the calling session", async () => {
    const cardId = await makeCard("spoken");
    await h.sql`INSERT INTO sessions(session_id,folder_id,card_id,status) VALUES ('spoken-session','comment-folder',${cardId},'running')`;
    const server = app();
    try {
      const posted = await server.inject({ method: "POST", url: `/api/cards/${cardId}/comments`,
        headers: { authorization: "Bearer service-test", "x-soulstream-agent-session-id": "spoken-session" },
        payload: { body: "회의에서 받은 요청", kind: "spoken", idempotencyKey: key() } });
      expect(posted.statusCode).toBe(201);
      expect(posted.json()).toMatchObject({ authorKind: "user", authorId: null, sessionId: "spoken-session", kind: "spoken", body: "회의에서 받은 요청" });
    } finally { await server.close(); }
  });
});

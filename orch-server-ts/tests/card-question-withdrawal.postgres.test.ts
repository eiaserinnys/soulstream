import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";
import { registerCardRoutes } from "../src/cards/card_routes.js";
import type { FolderRouteOptions } from "../src/folders/folder_routes.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

describe("card question withdrawal", () => {
  let h: PagePostgresHarness;
  let cards: CardControlPlaneService;
  let dispatcher: CardDispatcher;
  let sequence = 0;
  const messages = vi.fn(async (_sessionId: string, _text: string) => {});
  const human = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director@example.com" };
  const key = () => `question-withdrawal:${++sequence}`;

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`ALTER TABLE sessions ADD COLUMN model_preset TEXT, ADD COLUMN metadata JSONB,
      ADD COLUMN termination_reason TEXT, ADD COLUMN termination_event_id INTEGER`;
    await h.sql`INSERT INTO folders(id,name) VALUES ('withdrawal-folder','질문 철회')`;
    const sql = createBoardYjsSqlAdapter(h.liveSql);
    cards = new CardControlPlaneService(sql, {
      appendEventTx: async (tx, p) => {
        const rows = await tx<{ id: number }[]>`SELECT event_append(${p.sessionId},${p.eventType},${p.payload},${p.searchableText},${p.createdAt},${p.dedupeKey ?? null}) AS id`;
        return rows[0]!.id;
      },
    }, undefined, change => dispatcher.acceptMutation(change));
    dispatcher = new CardDispatcher({ deliveryExists: async () => false,
      repository: new CardDispatchRepository(async () => sql),
      cards: async () => cards,
      resolveTarget: () => ({ nodeId: "eiaserinnys", agentId: "roselin", modelPreset: null, available: true, reason: null }),
      launch: async () => {},
      sendMessage: messages,
      notify: async () => {},
      warn: () => {},
    });
  }, 60_000);

  afterAll(async () => { await dispatcher?.drain(); await h?.cleanup(); });

  beforeEach(async () => {
    await dispatcher.drain();
    await h.sql`DELETE FROM folder_operations WHERE folder_id='withdrawal-folder'`;
    await h.sql`DELETE FROM cards WHERE folder_id='withdrawal-folder'`;
    await h.sql`DELETE FROM sessions`;
    messages.mockClear();
  });

  async function makeCard(title = "질문을 철회할 카드") {
    const created = await cards.createCard({
      ...human,
      folderId: "withdrawal-folder",
      title,
      request: "요청",
      idempotencyKey: key(),
    });
    await dispatcher.drain();
    return created.operation.target_id;
  }

  async function withdraw(params: Record<string, unknown>) {
    const service = cards as unknown as {
      withdrawQuestion(input: Record<string, unknown>): Promise<unknown>;
    };
    return service.withdrawQuestion(params);
  }

  function app() {
    const server = Fastify();
    registerCardRoutes(server, {
      provider: { listFolders: () => [{ id: "withdrawal-folder" }], listSessionAssignments: () => ({}) },
      accessProvider: { resolveAccess: () => ({ restricted: false, allowedFolderIds: [] }) },
      resolveDashboardUserId: () => human.actorUserId,
      cardServiceProvider: async () => cards,
      authBearerToken: "service-test",
      environment: "production",
    } as unknown as FolderRouteOptions);
    return server;
  }

  it("stores the withdrawal and removes the question from open reads", async () => {
    const cardId = await makeCard();
    await h.sql`INSERT INTO sessions(session_id,status,metadata) VALUES
      ('asker','running',${h.sql.json([])}),
      ('current-assignee','running',${h.sql.json([])})`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_session_id='asker' WHERE id=${cardId}`;
    await cards.askQuestion({ actorKind: "agent", actorSessionId: "asker", cardId, text: "이대로 진행할까요?" });
    const questionId = String((await cards.getCard(cardId))!.questions[0]!.id);
    await h.sql`UPDATE cards SET assignee_session_id='current-assignee' WHERE id=${cardId}`;
    await dispatcher.drain();
    messages.mockClear();

    const server = app();
    try {
      const withdrawn = await server.inject({
        method: "POST",
        url: `/api/cards/${cardId}/questions/${questionId}/withdraw`,
        headers: { authorization: "Bearer service-test", "x-soulstream-agent-session-id": "current-assignee" },
        payload: { reason: "  대화에서 결정됨  ", idempotencyKey: key() },
      });
      expect(withdrawn.statusCode).toBe(200);
      const [stored] = await h.sql<{ withdrawn_at: Date | null; withdrawn_by_session_id: string | null; withdrawal_reason: string | null }[]>`
        SELECT withdrawn_at,withdrawn_by_session_id,withdrawal_reason FROM card_questions WHERE id=${questionId}`;
      expect(stored).toMatchObject({
        withdrawn_at: expect.any(Date),
        withdrawn_by_session_id: "current-assignee",
        withdrawal_reason: "대화에서 결정됨",
      });

      const detail = await server.inject({ method: "GET", url: `/api/cards/${cardId}` });
      expect(detail.json().card.status).toBe("running");
      expect(detail.json().questions[0]).toMatchObject({
        withdrawnAt: expect.any(String),
        withdrawnBySessionId: "current-assignee",
        withdrawalReason: "대화에서 결정됨",
      });

      const mcpDefault = await cards.mcpRead.getCard(cardId, {}, null);
      expect((mcpDefault.questions as { items: unknown[] }).items).toEqual([]);
      const mcpHistory = await cards.mcpRead.getCard(cardId, { include: ["questions_history"] }, null);
      expect(mcpHistory).toMatchObject({
        sections: { questions_history: { items: [expect.objectContaining({
          id: questionId,
          withdrawnAt: expect.any(String),
          withdrawnBySessionId: "current-assignee",
          withdrawalReason: "대화에서 결정됨",
        })] } },
      });

      const context = await cards.getSupervisedCardContext({
        sessionId: "asker", folderIds: ["withdrawal-folder"], cardLimit: 60, questionLimit: 10,
      });
      expect(context.openQuestions).toEqual([]);
      const lateAnswer = await server.inject({
        method: "POST",
        url: `/api/cards/${cardId}/questions/${questionId}/answer`,
        payload: { answer: "늦은 답", idempotencyKey: key() },
      });
      expect(lateAnswer.statusCode).toBeGreaterThanOrEqual(400);
      expect(lateAnswer.statusCode).toBeLessThan(500);
      expect(lateAnswer.json().detail.error.message).toBe("철회된 질문에는 답할 수 없습니다");
      await dispatcher.drain();
      expect(messages).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it("keeps the card blocked while another question is open, then answers the last open question", async () => {
    const cardId = await makeCard();
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('owner','running')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_session_id='owner' WHERE id=${cardId}`;
    await cards.askQuestion({ actorKind: "agent", actorSessionId: "owner", cardId, text: "첫 질문" });
    await cards.askQuestion({ actorKind: "agent", actorSessionId: "owner", cardId, text: "마지막 질문" });
    const questions = (await cards.getCard(cardId))!.questions;
    const firstId = String(questions.find(question => question.text === "첫 질문")!.id);
    const lastId = String(questions.find(question => question.text === "마지막 질문")!.id);

    await withdraw({ actorKind: "agent", actorSessionId: "owner", cardId, questionId: firstId, reason: "중복 결정" });
    expect((await cards.getCard(cardId))!.card).toMatchObject({ status: "blocked", blocked_kind: "question" });
    await cards.answerQuestion({ ...human, cardId, questionId: lastId, answer: "진행", idempotencyKey: key() });
    expect((await cards.getCard(cardId))!.card.status).toBe("running");
  });

  it("rejects non-assignees, dashboard actors, invalid reasons, missing, answered, and withdrawn questions", async () => {
    const cardId = await makeCard();
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('owner','running'),('other','running')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_session_id='owner' WHERE id=${cardId}`;
    await cards.askQuestion({ actorKind: "agent", actorSessionId: "owner", cardId, text: "기준 질문" });
    const questionId = String((await cards.getCard(cardId))!.questions[0]!.id);
    const input = { actorKind: "agent", actorSessionId: "owner", cardId, questionId, reason: "결정 완료" };

    await expect(withdraw({ ...input, actorSessionId: "other" })).rejects.toMatchObject({
      statusCode: 403,
      message: "Only the current assignee session may withdraw a card question.",
    });
    await expect(withdraw({ ...input, actorKind: "user", actorSessionId: null, actorUserId: "director" })).rejects.toMatchObject({
      statusCode: 403,
      message: "Only the current assignee session may withdraw a card question.",
    });
    await expect(withdraw({ ...input, reason: "  " })).rejects.toMatchObject({ statusCode: expect.any(Number) });
    await expect(withdraw({ ...input, reason: "가".repeat(201) })).rejects.toMatchObject({
      statusCode: expect.any(Number),
      message: expect.stringContaining("200"),
    });
    await expect(withdraw({ ...input, questionId: "missing-question" })).rejects.toMatchObject({
      statusCode: expect.any(Number), message: "Question not found in card",
    });

    await cards.answerQuestion({ ...human, cardId, questionId, answer: "이미 답함", idempotencyKey: key() });
    await expect(withdraw(input)).rejects.toMatchObject({
      statusCode: expect.any(Number), message: "Answered questions cannot be withdrawn",
    });

    await cards.askQuestion({ actorKind: "agent", actorSessionId: "owner", cardId, text: "철회 질문" });
    const withdrawnId = String((await cards.getCard(cardId))!.questions.find(question => question.text === "철회 질문")!.id);
    const withdrawnInput = { ...input, questionId: withdrawnId };
    await withdraw(withdrawnInput);
    await expect(withdraw(withdrawnInput)).rejects.toMatchObject({
      statusCode: expect.any(Number), message: "Question already withdrawn",
    });
  });
});

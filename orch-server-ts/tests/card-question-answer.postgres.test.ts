import { readFileSync } from "node:fs";
import postgres from "postgres";
import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startPostgresTestContainer } from "../../packages/db-schema/scripts/postgres-test-container.mjs";
import { waitForPostgres } from "./persistent-session-settings-world.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";
import { registerCardRoutes } from "../src/cards/card_routes.js";
import { CardMcpReadService, type CardMcpGetInput } from "../src/cards/card_mcp_read.js";
import { PersistentReportService } from "../src/session/persistent_report_service.js";
import { applyCardQuestionReply } from "../src/session/card_question_reply.js";
import type { FolderRouteOptions } from "../src/folders/folder_routes.js";

// Same disposable production-schema fixture as card-question-create-edit.postgres.test.ts.
describe("card question answer kinds and delivery to the current assignee", () => {
  let sql: ReturnType<typeof postgres>, stop: () => void;
  let cards: CardControlPlaneService, reports: PersistentReportService, dispatcher: CardDispatcher;
  let reader: {
    getCard: (cardId: string, input: CardMcpGetInput, allowedFolderIds: readonly string[] | null) => Promise<Record<string, any>>;
  };
  const human = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director" };
  const messages = vi.fn(async (_sessionId: string, _text: string, _admission?: unknown,
    _delivery?: { deliveryId: string }) => {});
  const warn = vi.fn();
  let sequence = 0;
  const key = () => `answer-test:${++sequence}`;

  beforeAll(async () => {
    const container = startPostgresTestContainer({
      user: "question_answer_test", password: "question_answer_test", database: "question_answer_test_db",
    });
    stop = container.stop;
    sql = postgres(`postgres://question_answer_test:question_answer_test@127.0.0.1:${container.port}/question_answer_test_db`, {
      max: 4, onnotice: () => {},
    });
    await waitForPostgres(sql);
    await sql.unsafe(readFileSync(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8"));
    expect(Number((await sql`SELECT COUNT(*) AS n FROM sessions`)[0]!.n)).toBe(0);
    await sql`INSERT INTO folders(id,name) VALUES('answer-folder','질문 답')`;
    const adapted = createFolderContentSqlAdapter(sql as never);
    cards = new CardControlPlaneService(adapted, { appendEventTx: async (tx, p) => {
      const rows = await tx<{ id: number }[]>`SELECT event_append(${p.sessionId},${p.eventType},${p.payload},${p.searchableText},${p.createdAt},${p.dedupeKey ?? null}) AS id`;
      return rows[0]!.id;
    } }, undefined, change => dispatcher.acceptMutation(change), () => {}, warn);
    reports = new PersistentReportService(adapted, () => {});
    dispatcher = new CardDispatcher({ repository: new CardDispatchRepository(async () => adapted), cards: async () => cards,
      resolveTarget: () => ({ nodeId: "node", agentId: "worker", modelPreset: null, available: false, reason: "test" }),
      launch: async () => {}, sendMessage: messages, notify: async () => {}, deliveryExists: async () => false,
      abandonDelivery: async () => {}, warn });
    reader = new CardMcpReadService(sql as never) as never;
  }, 90_000);

  beforeEach(async () => {
    await dispatcher.drain();
    await sql`DELETE FROM folder_operations`;
    await sql`DELETE FROM cards`;
    await sql`DELETE FROM sessions`;
    await sql`INSERT INTO sessions(session_id,folder_id,node_id,agent_id,status,metadata) VALUES
      ('pas','answer-folder','node','supervisor','running',${sql.json([{ type: "persistent_session", value: { enabled: true } }])}),
      ('old-board','answer-folder','node','worker','running','[]'),
      ('new-board','answer-folder','node','worker','running','[]'),
      ('old-rest','answer-folder','node','worker','running','[]'),
      ('new-rest','answer-folder','node','worker','running','[]'),
      ('old-fallback','answer-folder','node','worker','running','[]'),
      ('rest-choice','answer-folder','node','worker','running','[]'),
      ('rest-text','answer-folder','node','worker','running','[]'),
      ('rest-blank','answer-folder','node','worker','running','[]'),
      ('rest-long','answer-folder','node','worker','running','[]'),
      ('choice-only','answer-folder','node','worker','running','[]'),
      ('choice-add','answer-folder','node','worker','running','[]'),
      ('text-only','answer-folder','node','worker','running','[]'),
      ('text-label','answer-folder','node','worker','running','[]'),
      ('invalid-choice','answer-folder','node','worker','running','[]')`;
    messages.mockClear();
    warn.mockClear();
  });
  afterAll(async () => { await dispatcher?.drain(); await sql?.end({ timeout: 2 }); stop?.(); });

  async function createCard(title: string, sessionId: string): Promise<string> {
    const result = await cards.createCard({
      actorKind: "agent", actorSessionId: "pas", folderId: "answer-folder", title, request: "확인",
      assignee: { kind: "session", sessionId },
    });
    return String(result.operation.target_id);
  }

  async function ask(cardId: string, sessionId: string, text = "어떻게 할까요?", options = ["진행", "중단"]) {
    await cards.askQuestion({ actorKind: "agent", actorSessionId: sessionId, cardId, text, options, idempotencyKey: key() });
    await dispatcher.drain();
    const questionId = String((await cards.getCard(cardId))!.questions.at(-1)!.id);
    messages.mockClear();
    return questionId;
  }

  const stateLine = (title: string, cardId: string) =>
    `사용자가 카드 「${title}」(${cardId})를 막힘→실행 중으로 변경했습니다`;
  const answerNotice = (title: string, cardId: string, questionId: string, body: string[], status = "실행 중",
    question = "어떻게 할까요?") =>
    [`[카드 질문 답변] 카드 「${title}」(${cardId})`, `질문: ${question}`, `질문 ID: ${questionId}`,
      ...body, `카드 상태: ${status}`].join("\n");
  const stored = async (questionId: string) =>
    (await sql<{ answer: string | null; selected_option: string | null; answered_by: string | null }[]>`
      SELECT answer,selected_option,answered_by FROM card_questions WHERE id=${questionId}`)[0]!;

  it("stores choice, choice with an addition, and text answers and delivers the design text", async () => {
    const choiceCard = await createCard("답 종류 A", "choice-only");
    const choiceQuestion = await ask(choiceCard, "choice-only");
    await cards.answerQuestion({ ...human, cardId: choiceCard, questionId: choiceQuestion,
      mode: "choice", option: "진행", idempotencyKey: key() });
    await dispatcher.drain();
    expect(await stored(choiceQuestion)).toMatchObject({ answer: "진행", selected_option: "진행" });
    expect(messages).toHaveBeenCalledTimes(1);
    expect(messages.mock.calls[0]![0]).toBe("choice-only");
    expect(messages.mock.calls[0]![1]).toBe(`${stateLine("답 종류 A", choiceCard)}\n${answerNotice(
      "답 종류 A", choiceCard, choiceQuestion, ["고른 안: 진행", "덧붙임: 없음"])}`);

    const addCard = await createCard("답 종류 B", "choice-add");
    const addQuestion = await ask(addCard, "choice-add");
    await cards.answerQuestion({ ...human, cardId: addCard, questionId: addQuestion,
      mode: "choice", option: "중단", answer: "추가로 확인합니다", idempotencyKey: key() });
    await dispatcher.drain();
    expect(await stored(addQuestion)).toMatchObject({ answer: "추가로 확인합니다", selected_option: "중단" });
    expect(messages.mock.calls[0]![1]).toBe(`${stateLine("답 종류 B", addCard)}\n${answerNotice(
      "답 종류 B", addCard, addQuestion, ["고른 안: 중단", "덧붙임: 추가로 확인합니다"])}`);

    const textCard = await createCard("답 종류 C", "text-only");
    const textQuestion = await ask(textCard, "text-only");
    await cards.answerQuestion({ ...human, cardId: textCard, questionId: textQuestion,
      mode: "text", answer: "직접 판단합니다", idempotencyKey: key() });
    await dispatcher.drain();
    expect(await stored(textQuestion)).toMatchObject({ answer: "직접 판단합니다", selected_option: null });
    expect(messages.mock.calls[0]![1]).toBe(`${stateLine("답 종류 C", textCard)}\n${answerNotice(
      "답 종류 C", textCard, textQuestion, ["글 답: 직접 판단합니다"])}`);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects a choice outside the stored labels while a text answer and label-equal text both succeed", async () => {
    const cardId = await createCard("선택 밖", "invalid-choice");
    const questionId = await ask(cardId, "invalid-choice", "고를 것", ["진행"]);
    await expect(cards.answerQuestion({ ...human, cardId, questionId, mode: "choice", option: "없는 안", idempotencyKey: key() }))
      .rejects.toMatchObject({ statusCode: 422, code: "CARD_QUESTION_OPTION_INVALID" });
    expect(await stored(questionId)).toMatchObject({ answer: null, selected_option: null });

    await cards.answerQuestion({ ...human, cardId, questionId, mode: "text", answer: "목록 밖 글 답", idempotencyKey: key() });
    await dispatcher.drain();
    expect(await stored(questionId)).toMatchObject({ answer: "목록 밖 글 답", selected_option: null });

    const labelCard = await createCard("라벨 같은 글", "text-label");
    const labelQuestion = await ask(labelCard, "text-label", "고를 것", ["진행"]);
    await cards.answerQuestion({ ...human, cardId: labelCard, questionId: labelQuestion,
      mode: "text", answer: "진행", idempotencyKey: key() });
    await dispatcher.drain();
    expect(await stored(labelQuestion)).toMatchObject({ answer: "진행", selected_option: null });
    expect(messages.mock.calls[0]![1]).toContain("글 답: 진행");
    expect(messages.mock.calls[0]![1]).not.toContain("고른 안:");
  });

  function app() {
    const server = Fastify();
    registerCardRoutes(server, {
      provider: { listFolders: () => [{ id: "answer-folder" }], listSessionAssignments: () => ({}) },
      accessProvider: { resolveAccess: () => ({ restricted: false, allowedFolderIds: [] }) },
      resolveDashboardUserId: () => human.actorUserId,
      cardServiceProvider: async () => cards,
      authBearerToken: "service-test",
      environment: "production",
    } as unknown as FolderRouteOptions);
    return server;
  }

  it("keeps the old REST answer door for free text, reads a label-equal value as a choice, and rejects blanks", async () => {
    const choiceCard = await createCard("옛 꼴 선택", "rest-choice");
    const choiceQuestion = await ask(choiceCard, "rest-choice", "고를 것", ["진행", "중단"]);
    const textCard = await createCard("옛 꼴 글", "rest-text");
    const textQuestion = await ask(textCard, "rest-text", "고를 것", ["진행"]);
    const blankCard = await createCard("옛 꼴 빈 글", "rest-blank");
    const blankQuestion = await ask(blankCard, "rest-blank", "고를 것", ["진행"]);
    const longCard = await createCard("긴 글 답", "rest-long");
    const longQuestion = await ask(longCard, "rest-long", "고를 것", ["진행"]);
    const server = app();
    try {
      const choice = await server.inject({ method: "POST", url: `/api/cards/${choiceCard}/questions/${choiceQuestion}/answer`,
        payload: { answer: "진행", idempotencyKey: key() } });
      expect(choice.statusCode).toBe(200);
      await dispatcher.drain();
      expect(await stored(choiceQuestion)).toMatchObject({ answer: "진행", selected_option: "진행" });
      const choiceDetail = (await server.inject({ method: "GET", url: `/api/cards/${choiceCard}` })).json();
      expect(choiceDetail.questions[0]).toMatchObject({ id: choiceQuestion, selectedOption: "진행" });
      const choiceMcp = await reader.getCard(choiceCard, { include: ["questions_history"] } as CardMcpGetInput, null);
      expect(choiceMcp.sections.questions_history.items[0]).toMatchObject({ id: choiceQuestion, selectedOption: "진행" });

      const free = await server.inject({ method: "POST", url: `/api/cards/${textCard}/questions/${textQuestion}/answer`,
        payload: { answer: "다른 의견입니다", idempotencyKey: key() } });
      expect(free.statusCode).toBe(200);
      await dispatcher.drain();
      expect(await stored(textQuestion)).toMatchObject({ answer: "다른 의견입니다", selected_option: null });
      const textDetail = (await server.inject({ method: "GET", url: `/api/cards/${textCard}` })).json();
      expect(textDetail.questions[0]).toMatchObject({ id: textQuestion, selectedOption: null });

      for (const payload of [
        { answer: "   ", idempotencyKey: key() },
        { mode: "choice", option: "  ", idempotencyKey: key() },
        { mode: "text", answer: "  ", idempotencyKey: key() },
      ]) {
        const rejected = await server.inject({ method: "POST", url: `/api/cards/${blankCard}/questions/${blankQuestion}/answer`, payload });
        expect(rejected.statusCode).toBe(422);
      }
      expect(await stored(blankQuestion)).toMatchObject({ answer: null, selected_option: null });

      const longAnswer = "가".repeat(1500);
      const long = await server.inject({ method: "POST", url: `/api/cards/${longCard}/questions/${longQuestion}/answer`,
        payload: { mode: "text", answer: longAnswer, idempotencyKey: key() } });
      expect(long.statusCode).toBe(200);
      await dispatcher.drain();
      expect(await stored(longQuestion)).toMatchObject({ answer: longAnswer, selected_option: null });
    } finally { await server.close(); }
  });

  it("delivers to the assignee read at delivery time and falls back to the question session only without one", async () => {
    const boardCard = await createCard("담당 교체 판", "old-board");
    const boardQuestion = await ask(boardCard, "old-board", "어느 쪽?");
    await cards.patchCard({ ...human, cardId: boardCard, assignee: { kind: "session", sessionId: "new-board" } });
    await dispatcher.drain();
    messages.mockClear();
    const decision = await reports.acceptReply("pas",
      [{ key: "persistent_report_reply", content: { key: `cq_${boardQuestion}`, option: "진행" } }], { source: "browser" });
    expect(decision).toEqual({ action: "card", cardId: boardCard, questionId: boardQuestion, option: "진행" });
    if (decision.action !== "card") throw new Error(`Board answer rejected: ${JSON.stringify(decision)}`);
    await applyCardQuestionReply(decision, { sessionId: "pas", request: {} as FastifyRequest,
      requireSessionAccess: async () => {}, resolveAccess: async () => ({ restricted: false }), resolveActor: async () => human,
      cardOptions: { cardServiceProvider: async () => cards,
        provider: { listFolders: () => [{ id: "answer-folder" }], listSessionAssignments: () => ({}) } } });
    await dispatcher.drain();
    expect(messages).toHaveBeenCalledTimes(1);
    expect(messages.mock.calls[0]![0]).toBe("new-board");
    expect(messages.mock.calls[0]![1]).toBe(`${stateLine("담당 교체 판", boardCard)}\n${answerNotice(
      "담당 교체 판", boardCard, boardQuestion, ["고른 안: 진행", "덧붙임: 없음"], "실행 중", "어느 쪽?")}`);
    expect(messages.mock.calls.some(([id]) => id === "old-board")).toBe(false);
    expect(String((await sql<{ session_id: string }[]>`SELECT session_id FROM card_questions WHERE id=${boardQuestion}`)[0]!.session_id))
      .toBe("old-board");

    const restCard = await createCard("담당 교체 REST", "old-rest");
    const restQuestion = await ask(restCard, "old-rest", "어느 쪽?");
    await cards.patchCard({ ...human, cardId: restCard, assignee: { kind: "session", sessionId: "new-rest" } });
    await dispatcher.drain();
    messages.mockClear();
    const server = app();
    try {
      const posted = await server.inject({ method: "POST", url: `/api/cards/${restCard}/questions/${restQuestion}/answer`,
        payload: { answer: "새 담당에게", idempotencyKey: key() } });
      expect(posted.statusCode).toBe(200);
      await dispatcher.drain();
      expect(messages).toHaveBeenCalledTimes(1);
      expect(messages.mock.calls[0]![0]).toBe("new-rest");
      expect(messages.mock.calls[0]![1]).toBe(`${stateLine("담당 교체 REST", restCard)}\n${answerNotice(
        "담당 교체 REST", restCard, restQuestion, ["글 답: 새 담당에게"], "실행 중", "어느 쪽?")}`);
      expect(messages.mock.calls.some(([id]) => id === "old-rest")).toBe(false);
      expect(String((await sql<{ session_id: string }[]>`SELECT session_id FROM card_questions WHERE id=${restQuestion}`)[0]!.session_id))
        .toBe("old-rest");

      const fallbackCard = await createCard("담당 없음", "old-fallback");
      const fallbackQuestion = await ask(fallbackCard, "old-fallback", "어느 쪽?", ["진행"]);
      await cards.patchCard({ ...human, cardId: fallbackCard, assignee: null });
      await dispatcher.drain();
      messages.mockClear();
      const fallback = await server.inject({ method: "POST", url: `/api/cards/${fallbackCard}/questions/${fallbackQuestion}/answer`,
        payload: { answer: "진행", idempotencyKey: key() } });
      expect(fallback.statusCode).toBe(200);
      await dispatcher.drain();
      expect(messages).toHaveBeenCalledTimes(1);
      expect(messages.mock.calls[0]![0]).toBe("old-fallback");
      expect(messages.mock.calls[0]![1]).toBe(answerNotice(
        "담당 없음", fallbackCard, fallbackQuestion, ["고른 안: 진행", "덧붙임: 없음"], "실행 중", "어느 쪽?"));
      expect(messages.mock.calls[0]![3]).toMatchObject({
        deliveryId: expect.stringMatching(new RegExp(`^card:${fallbackCard}:answer:[^:]+:old-fallback$`)),
      });
      expect(String((await sql<{ session_id: string }[]>`SELECT session_id FROM card_questions WHERE id=${fallbackQuestion}`)[0]!.session_id))
        .toBe("old-fallback");
    } finally { await server.close(); }
  });
});

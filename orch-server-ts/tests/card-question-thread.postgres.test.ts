import { readFileSync } from "node:fs";
import postgres from "postgres";
import Fastify from "fastify";
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
import type { FolderRouteOptions } from "../src/folders/folder_routes.js";

// Same disposable production-schema fixture as card-question-answer.postgres.test.ts.
describe("card question threads keep the question open while user and assignee exchange comments", () => {
  let sql: ReturnType<typeof postgres>, stop: () => void;
  let cards: CardControlPlaneService, reports: PersistentReportService, dispatcher: CardDispatcher;
  let reader: {
    getCard: (cardId: string, input: CardMcpGetInput, allowedFolderIds: readonly string[] | null) => Promise<Record<string, any>>;
  };
  const human = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director" };
  const messages = vi.fn(async (_sessionId: string, _text: string, _admission?: unknown,
    _delivery?: { deliveryId: string }) => {});
  const pushes = vi.fn(async (_input: unknown) => {});
  const publish = vi.fn(async (_updates: unknown[]) => {});
  const warn = vi.fn();
  let sequence = 0;
  const key = () => `thread-test:${++sequence}`;

  beforeAll(async () => {
    const container = startPostgresTestContainer({
      user: "question_thread_test", password: "question_thread_test", database: "question_thread_test_db",
    });
    stop = container.stop;
    sql = postgres(`postgres://question_thread_test:question_thread_test@127.0.0.1:${container.port}/question_thread_test_db`, {
      max: 4, onnotice: () => {},
    });
    await waitForPostgres(sql);
    await sql.unsafe(readFileSync(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8"));
    expect(Number((await sql`SELECT COUNT(*) AS n FROM sessions`)[0]!.n)).toBe(0);
    await sql`INSERT INTO folders(id,name) VALUES('thread-folder','질문 글타래')`;
    const adapted = createFolderContentSqlAdapter(sql as never);
    cards = new CardControlPlaneService(adapted, { appendEventTx: async (tx, p) => {
      const rows = await tx<{ id: number }[]>`SELECT event_append(${p.sessionId},${p.eventType},${p.payload},${p.searchableText},${p.createdAt},${p.dedupeKey ?? null}) AS id`;
      return rows[0]!.id;
    } }, undefined, change => dispatcher.acceptMutation(change), publish, warn);
    reports = new PersistentReportService(adapted, publish);
    dispatcher = new CardDispatcher({ repository: new CardDispatchRepository(async () => adapted), cards: async () => cards,
      resolveTarget: () => ({ nodeId: "node", agentId: "worker", modelPreset: null, available: false, reason: "test" }),
      launch: async () => {}, sendMessage: messages, notify: pushes, deliveryExists: async () => false,
      abandonDelivery: async () => {}, warn });
    reader = new CardMcpReadService(sql as never) as never;
  }, 90_000);

  beforeEach(async () => {
    await dispatcher.drain();
    await sql`DELETE FROM folder_operations`;
    await sql`DELETE FROM cards`;
    await sql`DELETE FROM sessions`;
    await sql`INSERT INTO sessions(session_id,folder_id,node_id,agent_id,status,metadata) VALUES
      ('pas','thread-folder','node','supervisor','running',${sql.json([{ type: "persistent_session", value: { enabled: true } }])}),
      ('thread-worker','thread-folder','node','worker','running','[]'),
      ('add-choice','thread-folder','node','worker','running','[]'),
      ('add-text','thread-folder','node','worker','running','[]'),
      ('reject-worker','thread-folder','node','worker','running','[]'),
      ('j3-worker','thread-folder','node','worker','running','[]'),
      ('j5-asker','thread-folder','node','worker','running','[]'),
      ('j5-old','thread-folder','node','worker','running','[]'),
      ('j5-new','thread-folder','node','worker','running','[]'),
      ('replace-old','thread-folder','node','worker','running','[]'),
      ('replace-new','thread-folder','node','worker','running','[]'),
      ('closing-worker','thread-folder','node','worker','running','[]'),
      ('read-worker','thread-folder','node','worker','running','[]')`;
    messages.mockClear();
    pushes.mockClear();
    publish.mockClear();
    warn.mockClear();
  });
  afterAll(async () => { await dispatcher?.drain(); await sql?.end({ timeout: 2 }); stop?.(); });

  async function createCard(title: string, sessionId: string | null = null): Promise<string> {
    const result = await cards.createCard({
      actorKind: "agent", actorSessionId: "pas", folderId: "thread-folder", title, request: "확인",
      ...(sessionId === null ? {} : { assignee: { kind: "session" as const, sessionId } }),
    });
    return String(result.operation.target_id);
  }
  async function setItems(cardId: string, sessionId: string, items: string[]): Promise<void> {
    await cards.setCardItems({ actorKind: "agent", actorSessionId: sessionId, cardId, items, idempotencyKey: key() });
  }
  async function ask(cardId: string, sessionId: string, text = "어느 쪽으로 갈까요?", options = ["진행", "중단"]): Promise<string> {
    await cards.askQuestion({ actorKind: "agent", actorSessionId: sessionId, cardId, text, options, idempotencyKey: key() });
    await dispatcher.drain();
    const questionId = String((await cards.getCard(cardId))!.questions.at(-1)!.id);
    messages.mockClear();
    pushes.mockClear();
    return questionId;
  }
  async function reply(cardId: string, sessionId: string, questionId: string, body: string) {
    return cards.addComment({ actorKind: "agent", actorSessionId: sessionId, cardId, questionId, mode: "reply", body,
      idempotencyKey: key() });
  }
  const cardRow = async (cardId: string) =>
    (await sql<{ status: string; blocked_kind: string | null; assignee_kind: string | null;
      assignee_session_id: string | null }[]>`SELECT status,blocked_kind,assignee_kind,assignee_session_id
      FROM cards WHERE id=${cardId}`)[0]!;
  const questionRow = async (questionId: string) =>
    (await sql<{ answer: string | null; selected_option: string | null; withdrawn_at: Date | null }[]>`
      SELECT answer,selected_option,withdrawn_at FROM card_questions WHERE id=${questionId}`)[0]!;
  const threadRows = async (questionId: string) =>
    sql<{ id: string; author_kind: string; body: string; session_id: string | null; created_at: Date }[]>`
      SELECT id,author_kind,body,session_id,created_at FROM card_comments
      WHERE question_id=${questionId} ORDER BY created_at,id`;
  const boardEntry = async (questionId: string) =>
    (await reports.get("pas")).find(entry => entry.key === `cq_${questionId}`)!;
  const openNotice = (title: string, cardId: string, questionId: string, body: string, question = "어느 쪽으로 갈까요?") =>
    [`[카드 질문 되묻기] 카드 「${title}」(${cardId})`, `질문: ${question}`, `질문 ID: ${questionId}`,
      `되물은 글: ${body}`, "질문은 아직 열려 있습니다. 카드 상태는 막힘입니다.",
      `add_card_comment에 mode="reply", question_id="${questionId}"를 붙여 답하세요.`,
      `필요하면 ask_card_question에 question_id="${questionId}"를 붙여 질문을 제자리에서 고치세요.`].join("\n");
  const addedNotice = (title: string, cardId: string, questionId: string, answerLine: string, body: string,
    addition: string | undefined, question = "어느 쪽으로 갈까요?") =>
    [`[카드 질문 덧붙임] 카드 「${title}」(${cardId})`, `질문: ${question}`, `질문 ID: ${questionId}`,
      `받은 답: ${answerLine}`, ...(addition === undefined ? [] : [`덧붙임: ${addition}`]),
      `덧붙인 글: ${body}`, "질문은 닫혀 있습니다. 카드 상태는 실행 중입니다.",
      `답이 필요하면 add_card_comment에 mode="reply", question_id="${questionId}"를 붙여 답하세요.`].join("\n");

  function app() {
    const server = Fastify();
    registerCardRoutes(server, {
      provider: { listFolders: () => [{ id: "thread-folder" }], listSessionAssignments: () => ({}) },
      accessProvider: { resolveAccess: () => ({ restricted: false, allowedFolderIds: [] }) },
      resolveDashboardUserId: () => human.actorUserId,
      cardServiceProvider: async () => cards,
      authBearerToken: "service-test",
      environment: "production",
    } as unknown as FolderRouteOptions);
    return server;
  }

  it("repeats 되묻기 and 담당 답 without closing the question or the card", async () => {
    const cardId = await createCard("반복 글타래", "thread-worker");
    await setItems(cardId, "thread-worker", ["확인 항목"]);
    const questionId = await ask(cardId, "thread-worker");
    const server = app();
    try {
      const first = await server.inject({ method: "POST", url: `/api/cards/${cardId}/comments`,
        payload: { questionId, body: "선택지가 애매합니다", idempotencyKey: key() } });
      expect(first.statusCode).toBe(201);
      await dispatcher.drain();
      expect(messages).toHaveBeenCalledTimes(1);
      expect(messages.mock.calls[0]![0]).toBe("thread-worker");
      expect(messages.mock.calls[0]![1]).toBe(openNotice("반복 글타래", cardId, questionId, "선택지가 애매합니다"));
      expect(messages.mock.calls[0]![3]).toMatchObject({
        deliveryId: expect.stringMatching(new RegExp(`^card:${cardId}:question-comment:[^:]+:thread-worker$`)),
      });
      expect(pushes).not.toHaveBeenCalled();
      expect(await cardRow(cardId)).toMatchObject({ status: "blocked", blocked_kind: "question" });
      expect(await questionRow(questionId)).toMatchObject({ answer: null, withdrawn_at: null });
      expect((await boardEntry(questionId)).question_thread?.map(entry => entry.body)).toEqual(["선택지가 애매합니다"]);

      messages.mockClear();
      await reply(cardId, "thread-worker", questionId, "첫 번째 답");
      await dispatcher.drain();
      expect(messages).not.toHaveBeenCalled();
      expect(await questionRow(questionId)).toMatchObject({ answer: null, withdrawn_at: null });

      publish.mockClear();
      const second = await server.inject({ method: "POST", url: `/api/cards/${cardId}/comments`,
        payload: { questionId, body: "그래도 애매합니다", idempotencyKey: key() } });
      expect(second.statusCode).toBe(201);
      await dispatcher.drain();
      expect(messages).toHaveBeenCalledTimes(1);
      expect(messages.mock.calls[0]![0]).toBe("thread-worker");
      expect(messages.mock.calls[0]![1]).toBe(openNotice("반복 글타래", cardId, questionId, "그래도 애매합니다"));
      expect(pushes).not.toHaveBeenCalled();

      messages.mockClear();
      await reply(cardId, "thread-worker", questionId, "두 번째 답");
      await dispatcher.drain();
      expect(messages).not.toHaveBeenCalled();

      const rows = await threadRows(questionId);
      expect(rows.map(row => row.body)).toEqual(["선택지가 애매합니다", "첫 번째 답", "그래도 애매합니다", "두 번째 답"]);
      expect(rows.map(row => row.author_kind)).toEqual(["user", "agent", "user", "agent"]);
      expect(rows.map(row => row.session_id)).toEqual([null, "thread-worker", null, "thread-worker"]);
      expect(await cardRow(cardId)).toMatchObject({
        status: "blocked", blocked_kind: "question", assignee_kind: "session", assignee_session_id: "thread-worker",
      });
      expect(await questionRow(questionId)).toMatchObject({ answer: null, withdrawn_at: null });
      const entry = await boardEntry(questionId);
      expect(entry.question_thread?.map(item => item.body)).toEqual(rows.map(row => row.body));
      expect(entry.updated_at).toBe(rows.at(-1)!.created_at.toISOString());
      expect(publish).toHaveBeenCalled();
      expect(pushes).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it("appends to choice-answered and text-answered questions without reopening them", async () => {
    const choiceCard = await createCard("덧붙임 선택", "add-choice");
    const choiceQuestion = await ask(choiceCard, "add-choice");
    await cards.answerQuestion({ ...human, cardId: choiceCard, questionId: choiceQuestion,
      mode: "choice", option: "진행", idempotencyKey: key() });
    await dispatcher.drain();
    messages.mockClear();
    const textCard = await createCard("덧붙임 글", "add-text");
    const textQuestion = await ask(textCard, "add-text");
    await cards.answerQuestion({ ...human, cardId: textCard, questionId: textQuestion,
      mode: "text", answer: "직접 판단합니다", idempotencyKey: key() });
    await dispatcher.drain();
    messages.mockClear();
    const server = app();
    try {
      const choice = await server.inject({ method: "POST", url: `/api/cards/${choiceCard}/comments`,
        payload: { questionId: choiceQuestion, body: "문서도 고칩니다", idempotencyKey: key() } });
      expect(choice.statusCode).toBe(201);
      await dispatcher.drain();
      expect(messages).toHaveBeenCalledTimes(1);
      expect(messages.mock.calls[0]![0]).toBe("add-choice");
      expect(messages.mock.calls[0]![1]).toBe(addedNotice("덧붙임 선택", choiceCard, choiceQuestion,
        "고른 안: 진행", "문서도 고칩니다", undefined));
      expect(await questionRow(choiceQuestion)).toMatchObject({ answer: "진행", selected_option: "진행", withdrawn_at: null });
      expect(await cardRow(choiceCard)).toMatchObject({ status: "running", blocked_kind: null });

      messages.mockClear();
      const withAdditionCard = await createCard("덧붙임 선택 덧글", "add-choice");
      const withAdditionQuestion = await ask(withAdditionCard, "add-choice");
      await cards.answerQuestion({ ...human, cardId: withAdditionCard, questionId: withAdditionQuestion,
        mode: "choice", option: "중단", answer: "추가로 확인합니다", idempotencyKey: key() });
      await dispatcher.drain();
      messages.mockClear();
      const withAddition = await server.inject({ method: "POST", url: `/api/cards/${withAdditionCard}/comments`,
        payload: { questionId: withAdditionQuestion, body: "그렇게 갑니다", idempotencyKey: key() } });
      expect(withAddition.statusCode).toBe(201);
      await dispatcher.drain();
      expect(messages.mock.calls[0]![1]).toBe(addedNotice("덧붙임 선택 덧글", withAdditionCard, withAdditionQuestion,
        "고른 안: 중단", "그렇게 갑니다", "추가로 확인합니다"));

      messages.mockClear();
      const text = await server.inject({ method: "POST", url: `/api/cards/${textCard}/comments`,
        payload: { questionId: textQuestion, body: "그렇게 갑니다", idempotencyKey: key() } });
      expect(text.statusCode).toBe(201);
      await dispatcher.drain();
      expect(messages.mock.calls[0]![1]).toBe(addedNotice("덧붙임 글", textCard, textQuestion,
        "글 답: 직접 판단합니다", "그렇게 갑니다", undefined));
      expect(await questionRow(textQuestion)).toMatchObject({ answer: "직접 판단합니다", selected_option: null });
      expect(await questionRow(choiceQuestion)).toMatchObject({ answer: "진행" });
    } finally { await server.close(); }
  });

  it("rejects withdrawn, foreign and missing questions and item or spoken combinations", async () => {
    const withdrawnCard = await createCard("철회 질문", "reject-worker");
    const withdrawnQuestion = await ask(withdrawnCard, "reject-worker");
    await cards.withdrawQuestion({ actorKind: "agent", actorSessionId: "reject-worker", cardId: withdrawnCard,
      questionId: withdrawnQuestion, reason: "정리", idempotencyKey: key() });
    await dispatcher.drain();
    messages.mockClear();
    const sourceCard = await createCard("원본 질문");
    const sourceQuestion = await ask(sourceCard, "pas");
    const otherCard = await createCard("다른 카드");
    const server = app();
    try {
      const cases = [
        { cardId: withdrawnCard, body: { questionId: withdrawnQuestion, body: "철회 뒤 글", idempotencyKey: key() } },
        { cardId: otherCard, body: { questionId: sourceQuestion, body: "다른 카드 질문", idempotencyKey: key() } },
        { cardId: otherCard, body: { questionId: "missing-question", body: "없는 질문", idempotencyKey: key() } },
        { cardId: otherCard, body: { questionId: sourceQuestion, itemId: 1, body: "항목까지", idempotencyKey: key() } },
        { cardId: otherCard, body: { questionId: sourceQuestion, kind: "spoken", body: "말로", idempotencyKey: key() } },
        { cardId: otherCard, body: { questionId: sourceQuestion, mode: "spoken", body: "말로", idempotencyKey: key() } },
      ];
      for (const rejected of cases) {
        const response = await server.inject({ method: "POST", url: `/api/cards/${rejected.cardId}/comments`,
          payload: rejected.body });
        expect(response.statusCode).toBe(422);
      }
      const stored = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM card_comments
        WHERE question_id IS NOT NULL AND card_id IN (${withdrawnCard},${otherCard})`;
      expect(stored[0]!.n).toBe(0);
    } finally { await server.close(); }
  });

  it("keeps the reply-once rule inside a thread instead of across threads or general comments", async () => {
    const cardId = await createCard("글타래 답 규칙", "j3-worker");
    await setItems(cardId, "j3-worker", ["확인 항목"]);
    const server = app();
    try {
      const general = await server.inject({ method: "POST", url: `/api/cards/${cardId}/comments`,
        payload: { body: "일반 커멘트", idempotencyKey: key() } });
      expect(general.statusCode).toBe(201);
      const firstQuestion = await ask(cardId, "j3-worker");
      const secondQuestion = await ask(cardId, "j3-worker");
      for (const [questionId, body] of [[secondQuestion, "둘째 질문 글"], [firstQuestion, "첫째 질문 글"]] as const) {
        const posted = await server.inject({ method: "POST", url: `/api/cards/${cardId}/comments`,
          payload: { questionId, body, idempotencyKey: key() } });
        expect(posted.statusCode).toBe(201);
      }
      messages.mockClear();

      await reply(cardId, "j3-worker", firstQuestion, "첫째 답");
      await dispatcher.drain();
      await reply(cardId, "j3-worker", secondQuestion, "둘째 답");
      await dispatcher.drain();
      await reply(cardId, "j3-worker", firstQuestion, "첫째 두 번째 답").then(
        () => { throw new Error("a second reply in the same thread must be rejected"); },
        error => expect(error).toMatchObject({ statusCode: 422, code: "INVALID_CARD_REQUEST" }));
      await expect(reply(cardId, "j3-worker", secondQuestion, "가".repeat(301)))
        .rejects.toMatchObject({ statusCode: 422, code: "INVALID_CARD_REQUEST" });
      expect(messages).not.toHaveBeenCalled();

      const repost = await server.inject({ method: "POST", url: `/api/cards/${cardId}/comments`,
        payload: { questionId: firstQuestion, body: "새로 남긴 글", idempotencyKey: key() } });
      expect(repost.statusCode).toBe(201);
      await dispatcher.drain();
      await reply(cardId, "j3-worker", firstQuestion, "다시 받은 질문");
      messages.mockClear();
      const generalReply = await cards.addComment({ actorKind: "agent", actorSessionId: "j3-worker",
        cardId, mode: "reply", body: "일반 커멘트 답", idempotencyKey: key() });
      expect(String(generalReply.id)).not.toBe("");
      await dispatcher.drain();
      expect(messages).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it("lets the question creator reply only while the card has no assignee", async () => {
    const unassignedCard = await createCard("담당 없는 글타래");
    const unassignedQuestion = await ask(unassignedCard, "j5-asker");
    await reply(unassignedCard, "j5-asker", unassignedQuestion, "질문 세션의 답");
    expect(await cardRow(unassignedCard)).toMatchObject({ assignee_kind: null, assignee_session_id: null,
      status: "blocked", blocked_kind: "question" });
    expect(await questionRow(unassignedQuestion)).toMatchObject({ answer: null, withdrawn_at: null });

    const assignedCard = await createCard("담당 있는 글타래", "j5-old");
    const assignedQuestion = await ask(assignedCard, "j5-old");
    await cards.patchCard({ ...human, cardId: assignedCard, assignee: { kind: "session", sessionId: "j5-new" },
      idempotencyKey: key() });
    await dispatcher.drain();
    messages.mockClear();
    await expect(reply(assignedCard, "j5-old", assignedQuestion, "옛 담당의 답"))
      .rejects.toMatchObject({ statusCode: 422, code: "INVALID_CARD_REQUEST" });
    await reply(assignedCard, "j5-new", assignedQuestion, "새 담당의 답");
    expect(await cardRow(assignedCard)).toMatchObject({ assignee_kind: "session", assignee_session_id: "j5-new" });
  });

  it("delivers 되묻기 to the assignee read at delivery time and falls back to the question session", async () => {
    const cardId = await createCard("담당 교체 글타래", "replace-old");
    const questionId = await ask(cardId, "replace-old");
    await cards.patchCard({ ...human, cardId, assignee: { kind: "session", sessionId: "replace-new" },
      idempotencyKey: key() });
    await dispatcher.drain();
    messages.mockClear();
    const server = app();
    try {
      const replaced = await server.inject({ method: "POST", url: `/api/cards/${cardId}/comments`,
        payload: { questionId, body: "새 담당에게", idempotencyKey: key() } });
      expect(replaced.statusCode).toBe(201);
      await dispatcher.drain();
      expect(messages).toHaveBeenCalledTimes(1);
      expect(messages.mock.calls[0]![0]).toBe("replace-new");
      expect(messages.mock.calls[0]![1]).toBe(openNotice("담당 교체 글타래", cardId, questionId, "새 담당에게"));
      expect(messages.mock.calls.some(([sessionId]) => sessionId === "replace-old")).toBe(false);
      expect(String((await sql<{ session_id: string }[]>`SELECT session_id FROM card_questions WHERE id=${questionId}`)[0]!.session_id))
        .toBe("replace-old");

      await cards.patchCard({ ...human, cardId, assignee: null, idempotencyKey: key() });
      await dispatcher.drain();
      messages.mockClear();
      const fallback = await server.inject({ method: "POST", url: `/api/cards/${cardId}/comments`,
        payload: { questionId, body: "질문 세션에게", idempotencyKey: key() } });
      expect(fallback.statusCode).toBe(201);
      await dispatcher.drain();
      expect(messages).toHaveBeenCalledTimes(1);
      expect(messages.mock.calls[0]![0]).toBe("replace-old");
      expect(messages.mock.calls[0]![1]).toBe(openNotice("담당 교체 글타래", cardId, questionId, "질문 세션에게"));
    } finally { await server.close(); }
  });

  it("keeps withdrawing and resuming on user comments without a question id", async () => {
    const cardId = await createCard("닫힘 규칙", "closing-worker");
    const questionId = await ask(cardId, "closing-worker");
    const server = app();
    try {
      const posted = await server.inject({ method: "POST", url: `/api/cards/${cardId}/comments`,
        payload: { body: "다시 진행해 주세요", idempotencyKey: key() } });
      expect(posted.statusCode).toBe(201);
      await dispatcher.drain();
      const question = await questionRow(questionId);
      expect(question.answer).toBeNull();
      expect(question.withdrawn_at).not.toBeNull();
      expect(await cardRow(cardId)).toMatchObject({ status: "running", blocked_kind: null });
    } finally { await server.close(); }
  });

  it("exposes questionId on REST detail and MCP comments after a threaded comment", async () => {
    const cardId = await createCard("읽기 글타래", "read-worker");
    const questionId = await ask(cardId, "read-worker");
    const before = await reader.getCard(cardId, { include: ["comments"] }, null);
    const server = app();
    try {
      const posted = await server.inject({ method: "POST", url: `/api/cards/${cardId}/comments`,
        payload: { questionId, body: "읽기 확인", idempotencyKey: key() } });
      expect(posted.statusCode).toBe(201);
      const commentId = String((posted.json() as { id: string }).id);
      await dispatcher.drain();
      const detail = (await server.inject({ method: "GET", url: `/api/cards/${cardId}` })).json();
      expect(detail.comments.find((comment: { id: string }) => comment.id === commentId))
        .toMatchObject({ id: commentId, questionId });
      const mcp = await reader.getCard(cardId, { include: ["comments"] }, null);
      expect(mcp.sections.comments.items.find((comment: { id: string }) => comment.id === commentId))
        .toMatchObject({ id: commentId, questionId });
      const since = await reader.getCard(cardId, { since: before.changeToken, include: ["comments"] }, null);
      expect(since.changed).toContain("comments");
      expect(since.sections.comments).toMatchObject({
        replace: true,
        items: [expect.objectContaining({ id: commentId, questionId })],
      });
    } finally { await server.close(); }
  });
});

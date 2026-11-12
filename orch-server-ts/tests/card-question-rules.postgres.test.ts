import { readFileSync } from "node:fs";
import postgres from "postgres";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startPostgresTestContainer } from "../../packages/db-schema/scripts/postgres-test-container.mjs";
import { waitForPostgres } from "./persistent-session-settings-world.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";
import { PersistentReportService } from "../src/session/persistent_report_service.js";
import { applyCardQuestionReply } from "../src/session/card_question_reply.js";

// Same disposable production-schema fixture as persistent-report.postgres.test.ts.
describe("card question answers and author withdrawal", () => {
  let sql: ReturnType<typeof postgres>, stop: () => void;
  let cards: CardControlPlaneService, reports: PersistentReportService, dispatcher: CardDispatcher;
  const human = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director" };
  const messages = vi.fn(async (_sessionId: string, _text: string) => {});
  const warn = vi.fn();
  beforeAll(async () => {
    const container = startPostgresTestContainer({ user: "question_rules_test", password: "question_rules_test", database: "question_rules_test_db" });
    stop = container.stop;
    sql = postgres(`postgres://question_rules_test:question_rules_test@127.0.0.1:${container.port}/question_rules_test_db`, { max: 4, onnotice: () => {} });
    await waitForPostgres(sql);
    await sql.unsafe(readFileSync(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8"));
    expect(Number((await sql`SELECT COUNT(*) AS n FROM sessions`)[0]!.n)).toBe(0);
    await sql`INSERT INTO folders(id,name) VALUES('question-rules','질문 규칙')`;
    const adapted = createFolderContentSqlAdapter(sql as never);
    cards = new CardControlPlaneService(adapted, { appendEventTx: async (tx, p) => {
      const rows = await tx<{ id: number }[]>`SELECT event_append(${p.sessionId},${p.eventType},${p.payload},${p.searchableText},${p.createdAt},${p.dedupeKey ?? null}) AS id`;
      return rows[0]!.id;
    } }, undefined, change => dispatcher.acceptMutation(change), () => {});
    reports = new PersistentReportService(adapted, () => {});
    dispatcher = new CardDispatcher({ repository: new CardDispatchRepository(async () => adapted), cards: async () => cards,
      resolveTarget: () => ({ nodeId: "node", agentId: "worker", modelPreset: null, available: false, reason: "test" }),
      launch: async () => {}, sendMessage: messages, notify: async () => {}, deliveryExists: async () => false, abandonDelivery: async () => {}, warn });
  }, 60_000);
  beforeEach(async () => {
    await dispatcher.drain();
    await sql`DELETE FROM folder_operations`;
    await sql`DELETE FROM cards`;
    await sql`DELETE FROM sessions`;
    await sql`INSERT INTO sessions(session_id,folder_id,node_id,agent_id,status,metadata) VALUES
      ('pas','question-rules','node','worker','running',${sql.json([{type:"persistent_session",value:{enabled:true}}])}),
      ('author','question-rules','node','worker','running','[]'),
      ('replacement','question-rules','node','worker','running','[]'),
      ('unrelated','question-rules','node','worker','running','[]')`;
    messages.mockClear(); warn.mockClear();
  });
  afterAll(async () => { await dispatcher?.drain(); await sql?.end({ timeout: 2 }); stop?.(); });

  async function ask(assigned: boolean) {
    const cardId = (await cards.createCard({ actorKind: "agent", actorSessionId: "pas", folderId: "question-rules", title: "질문", request: "확인",
      ...(assigned ? { assignee: { kind: "session" as const, sessionId: "author" } } : {}) })).operation.target_id;
    await cards.askQuestion({ actorKind: "agent", actorSessionId: "author", cardId, text: "진행할까요?", options: ["진행"] });
    const questionId = String((await cards.getCard(cardId))!.questions[0]!.id);
    await reports.placeQuestion(cardId, questionId);
    await dispatcher.drain();
    return { cardId, questionId };
  }

  it('rejects an agent answer before the stale-version fence', async () => {
    const {cardId,questionId}=await ask(true);
    const version=(await cards.getCard(cardId))!.card.version;
    await expect(cards.answerQuestion({actorKind:'agent',actorSessionId:'author',cardId,questionId,
      expectedVersion:version-1,answer:'진행'})).rejects.toMatchObject({statusCode:422,code:'INVALID_CARD_REQUEST',message:'Only a human may answer card questions'});
    expect((await cards.getCard(cardId))!.card.version).toBe(version);
    expect((await cards.getCard(cardId))!.questions[0]!.answer).toBeNull();
  });

  it.each(["done", "cancelled", "on_hold"] as const)("accepts a late %s answer from either door and delivers once to the current assignee", async status => {
    const statusLabel = { done: "완료", cancelled: "취소", on_hold: "보류" }[status];
    for (const door of ["detail", "board"] as const) {
      const { cardId, questionId } = await ask(true);
      await cards.patchCard({ ...human, cardId, assignee: { kind: "session", sessionId: "replacement" } });
      await cards.setCardStatus({ ...human, cardId, status });
      await dispatcher.drain(); messages.mockClear();
      const before = (await cards.getCard(cardId))!.card;
      expect((await reports.get("pas")).some(e => e.key === `cq_${questionId}`)).toBe(false);
      const context = [{ key: "persistent_report_reply", content: { key: `cq_${questionId}`, option: "진행" } }];
      if (door === "detail") {
        const input = { ...human, cardId, questionId, answer: "진행", idempotencyKey: `detail:${questionId}` };
        await cards.answerQuestion(input);
        await cards.answerQuestion(input);
      } else {
        const decision = await reports.acceptReply("pas", context, { source: "browser" });
        expect(decision.action).toBe("card");
        if (decision.action !== "card") throw new Error(`Late board answer rejected: ${JSON.stringify(decision)}`);
        await applyCardQuestionReply(decision, { sessionId: "pas", request: {} as FastifyRequest,
          requireSessionAccess: async () => {}, resolveAccess: async () => ({ restricted: false }), resolveActor: async () => human,
          cardOptions: { cardServiceProvider: async () => cards, provider: { listFolders: () => [{ id: "question-rules" }], listSessionAssignments: () => ({}) } } });
        expect(await reports.acceptReply("pas", context, { source: "soul-app" })).toEqual({ action: "card-acked", cardId });
      }
      await dispatcher.drain();
      const after = (await cards.getCard(cardId))!;
      expect(after.card).toMatchObject({ status, completed_at: before.completed_at, completed_kind: before.completed_kind, completed_user_id: before.completed_user_id });
      expect(after.questions[0]).toMatchObject({ answer: "진행", selected_option: "진행", session_id: "author" });
      const answers = messages.mock.calls.filter(([, text]) => text.includes("[카드 질문 답변]"));
      expect(answers).toHaveLength(1);
      expect(answers[0]![0]).toBe("replacement");
      expect(answers[0]![1]).toBe(`[카드 질문 답변] 카드 「질문」(${cardId})`
        + `\n질문: 진행할까요?\n질문 ID: ${questionId}\n고른 안: 진행\n덧붙임: 없음\n카드 상태: ${statusLabel}`);
      expect(messages.mock.calls.some(([id]) => id === "author")).toBe(false);
      expect((await reports.get("pas")).some(e => e.card_id === cardId)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      // The next door uses a fresh card and the same author, preserving single-card assignment.
      await cards.patchCard({ ...human, cardId, assignee: null });
    }
  });

  it.each([false, true])("lets the question author withdraw without broadening card write permission, replacement=%s", async replacement => {
    const { cardId, questionId } = await ask(false);
    if (replacement) await cards.patchCard({ ...human, cardId, assignee: { kind: "session", sessionId: "replacement" } });
    await expect(cards.withdrawQuestion({ actorKind: "agent", actorSessionId: "unrelated", cardId, questionId, reason: "무관" })).rejects.toMatchObject({ statusCode: 403 });
    await cards.withdrawQuestion({ actorKind: "agent", actorSessionId: "author", cardId, questionId, reason: "대화로 결정" });
    const detail = (await cards.getCard(cardId))!;
    expect(detail.questions[0]).toMatchObject({ withdrawn_at: expect.any(Date), withdrawn_by_session_id: "author" });
    expect(detail.card).toMatchObject({ status: "running", assignee_session_id: replacement ? "replacement" : null });
    await expect(cards.updateCardNow({ actorKind: "agent", actorSessionId: "author", cardId, now: "권한 없음", turn: "agent" })).rejects.toMatchObject({ statusCode: expect.any(Number) });
    await expect(cards.setCardStatus({ actorKind: "agent", actorSessionId: "author", cardId, status: "review" })).rejects.toMatchObject({ statusCode: 403 });
  });
});

import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
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
    await h.sql`ALTER TABLE sessions ADD COLUMN model_preset TEXT, ADD COLUMN metadata JSONB,
      ADD COLUMN termination_reason TEXT, ADD COLUMN termination_event_id INTEGER`;
    await h.sql`INSERT INTO folders(id,name) VALUES ('comment-folder','커멘트')`;
    const sql = createFolderContentSqlAdapter(h.liveSql);
    cards = new CardControlPlaneService(sql, {
      appendEventTx: async (tx, p) => {
        const rows = await tx<{ id: number }[]>`SELECT event_append(${p.sessionId},${p.eventType},${p.payload},${p.searchableText},${p.createdAt},${p.dedupeKey ?? null}) AS id`;
        return rows[0]!.id;
      },
    }, { emitCardUpdated: cardUpdated, emitFolderUpdated: async () => {} }, change => dispatcher.acceptMutation(change));
    dispatcher = new CardDispatcher({ deliveryExists: async () => false, abandonDelivery: async () => {},
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

  it("sends actual external state changes once to the captured owner, excluding same state, own changes and done",async()=>{
    const cardId=await makeCard(),otherId=await makeCard("다른 카드");
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('owner','running'),('other','running')`;
    await h.sql`UPDATE cards SET assignee_session_id='owner',assignee_kind='session' WHERE id=${cardId}`;
    await h.sql`UPDATE cards SET assignee_session_id='other',assignee_kind='session' WHERE id=${otherId}`;
    const input={...human,cardId,status:"running" as const,idempotencyKey:key()};
    await cards.setCardStatus(input);await dispatcher.drain();
    expect(messages).toHaveBeenCalledOnce();expect(messages.mock.calls[0]).toEqual([
      'owner',expect.stringContaining('할 일→실행 중'),undefined,expect.objectContaining({deliveryId:expect.stringContaining(':state:')}),
    ]);
    await cards.setCardStatus(input);await dispatcher.drain();
    await cards.setCardStatus({...human,cardId,status:'running'});await dispatcher.drain();
    await cards.setCardStatus({...human,actorSessionId:'owner',cardId,status:'todo'});await dispatcher.drain();
    await cards.setCardStatus({...human,cardId,status:'done'});await dispatcher.drain();
    expect(messages).toHaveBeenCalledOnce();
    expect((await cards.getCard(otherId))?.card.status).toBe('todo');
  });

  it("delivers a question answer and its status change in one existing owner input",async()=>{
    const cardId=await makeCard();
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('owner','running')`;
    await h.sql`UPDATE cards SET status='running',assignee_kind='session',assignee_session_id='owner' WHERE id=${cardId}`;
    await cards.askQuestion({actorKind:'agent',actorSessionId:'owner',cardId,text:'어떻게 진행합니까?',options:['진행']});await dispatcher.drain();
    messages.mockClear();
    const question=(await cards.getCard(cardId))!.questions[0]!;
    const answer={...human,cardId,questionId:String(question.id),answer:'원래 흐름으로 진행합니다',idempotencyKey:key()};
    await cards.answerQuestion(answer);await dispatcher.drain();
    await cards.answerQuestion(answer);await dispatcher.drain();
    expect(messages).toHaveBeenCalledOnce();
    expect(messages.mock.calls[0]).toEqual(['owner',
      `사용자가 카드 「커멘트 대상」(${cardId})를 막힘→실행 중으로 변경했습니다\n[카드 질문 답변] 카드 「커멘트 대상」(${cardId})`
      + `\n질문: 어떻게 진행합니까?\n질문 ID: ${String(question.id)}\n글 답: 원래 흐름으로 진행합니다\n카드 상태: 실행 중`,
      undefined,expect.objectContaining({deliveryId:expect.stringContaining(':state:')})]);
  });

  it("resumes eligible question-blocked cards on a user comment and closes open questions", async () => {
    const cardId = await makeCard("커멘트로 재개");
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('comment-resume-owner','running')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_session_id='comment-resume-owner' WHERE id=${cardId}`;
    await cards.askQuestion({ actorKind:'agent',actorSessionId:'comment-resume-owner',cardId,text:'결정이 필요합니다',options:['진행'] });
    const questionId = String((await cards.getCard(cardId))!.questions[0]!.id);

    await cards.addComment({ ...human,cardId,body:'이대로 진행해 주세요',idempotencyKey:key() });

    expect((await cards.getCard(cardId))!.card).toMatchObject({ status:'running',blocked_kind:null,blocked_detail:null });
    expect((await h.sql`SELECT withdrawn_at,withdrawn_by_session_id,withdrawal_reason FROM card_questions WHERE id=${questionId}`)[0])
      .toMatchObject({ withdrawn_at:expect.any(Date),withdrawn_by_session_id:null,
        withdrawal_reason:'사용자가 커멘트로 답해 서버가 닫았습니다' });
  });

  it("resumes a verification-wait card on a user comment but not on an assignee reply", async () => {
    const cardId = await makeCard("검증 대기 커멘트");
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('verify-comment-owner','running')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_session_id='verify-comment-owner' WHERE id=${cardId}`;
    const enter = async () => cards.setCardStatus({ ...human, cardId, status: 'awaiting_verification',
      expectedVersion: (await cards.getCard(cardId))!.card.version, idempotencyKey: key(),
      wakeAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), waitingFor: '배포 확인' });
    await enter();
    await cards.addComment({ ...human, cardId, body: '배포 확인했어요', idempotencyKey: key() });
    expect((await h.sql`SELECT status,wake_at,waiting_for FROM cards WHERE id=${cardId}`)[0])
      .toMatchObject({ status: 'running', wake_at: null, waiting_for: null });

    await enter();
    await cards.addComment({ actorKind: 'agent', actorSessionId: 'verify-comment-owner', cardId,
      body: '확인 중입니다', mode: 'reply', idempotencyKey: key() });
    expect((await h.sql`SELECT status,wake_at,waiting_for FROM cards WHERE id=${cardId}`)[0])
      .toMatchObject({ status: 'awaiting_verification', wake_at: expect.any(Date), waiting_for: '배포 확인' });
  });

  it("resumes a blocked card on human session input and leaves limit-blocked cards unchanged", async () => {
    const cardId = await makeCard("메시지로 재개");
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('message-resume-owner','running'),('message-limit-owner','running')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_session_id='message-resume-owner' WHERE id=${cardId}`;
    await cards.askQuestion({actorKind:'agent',actorSessionId:'message-resume-owner',cardId,text:'결정이 필요합니다',options:['진행']});
    const detail = (await cards.getCard(cardId))!;
    const questionId = String(detail.questions[0]!.id);

    await cards.resumeBlockedCardOnHumanInput({cardId,expectedVersion:detail.card.version});

    expect((await cards.getCard(cardId))!.card).toMatchObject({status:'running',blocked_kind:null,blocked_detail:null});
    expect((await h.sql`SELECT withdrawn_at,withdrawn_by_session_id,withdrawal_reason FROM card_questions WHERE id=${questionId}`)[0])
      .toMatchObject({withdrawn_at:expect.any(Date),withdrawn_by_session_id:null,
        withdrawal_reason:'사용자 메시지로 작업이 재개되어 서버가 닫았습니다'});

    const limitId = await makeCard("메시지 한도 유지");
    const reviewId = await makeCard("메시지 검수 유지");
    await h.sql`UPDATE cards SET status='blocked',blocked_kind='limit',blocked_detail='한도',assignee_kind='session',assignee_session_id='message-limit-owner' WHERE id=${limitId}`;
    await h.sql`UPDATE cards SET status='review',assignee_kind='session',assignee_session_id='message-resume-owner' WHERE id=${reviewId}`;
    const limitVersion = (await cards.getCard(limitId))!.card.version;
    await cards.resumeBlockedCardOnHumanInput({cardId:limitId,expectedVersion:limitVersion});
    const reviewVersion = (await cards.getCard(reviewId))!.card.version;
    await cards.resumeBlockedCardOnHumanInput({cardId:reviewId,expectedVersion:reviewVersion});
    expect((await cards.getCard(limitId))!.card).toMatchObject({status:'blocked',blocked_kind:'limit',blocked_detail:'한도'});
    expect((await cards.getCard(reviewId))!.card.status).toBe('review');

    const verifyId = await makeCard("메시지 검증 대기 재개");
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_session_id='message-resume-owner' WHERE id=${verifyId}`;
    await cards.setCardStatus({...human,cardId:verifyId,status:'awaiting_verification',expectedVersion:1,idempotencyKey:key(),
      wakeAt:new Date(Date.now()+60*60*1000).toISOString(),waitingFor:'배포 확인'});
    const verifyVersion = (await cards.getCard(verifyId))!.card.version;
    await cards.resumeBlockedCardOnHumanInput({cardId:verifyId,expectedVersion:verifyVersion});
    expect((await h.sql`SELECT status,wake_at,waiting_for FROM cards WHERE id=${verifyId}`)[0])
      .toMatchObject({status:'running',wake_at:null,waiting_for:null});
  });

  it("keeps review and limit-blocked cards unchanged when a user comments", async () => {
    const reviewId = await makeCard("검수 커멘트");
    const limitId = await makeCard("한도 막힘 커멘트");
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('comment-review-owner','running'),('comment-limit-owner','running')`;
    await h.sql`UPDATE cards SET status='review',assignee_kind='session',assignee_session_id='comment-review-owner' WHERE id=${reviewId}`;
    await h.sql`UPDATE cards SET status='blocked',blocked_kind='limit',blocked_detail='한도',assignee_kind='session',assignee_session_id='comment-limit-owner' WHERE id=${limitId}`;

    await cards.addComment({ ...human,cardId:reviewId,body:'검수 참고',idempotencyKey:key() });
    await cards.addComment({ ...human,cardId:limitId,body:'한도 상태 확인',idempotencyKey:key() });

    expect((await cards.getCard(reviewId))!.card.status).toBe('review');
    expect((await cards.getCard(limitId))!.card).toMatchObject({ status:'blocked',blocked_kind:'limit' });
  });

  it("retains a distinct question recipient and leaves unanswered questions blocked",async()=>{
    const cardId=await makeCard();
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('old-owner','running'),('new-owner','running')`;
    await h.sql`UPDATE cards SET status='running',assignee_kind='session',assignee_session_id='old-owner' WHERE id=${cardId}`;
    await cards.askQuestion({actorKind:'agent',actorSessionId:'old-owner',cardId,text:'이전 담당 질문',options:['진행']});await dispatcher.drain();
    const question=(await cards.getCard(cardId))!.questions[0]!;
    await h.sql`INSERT INTO card_questions(id,card_id,session_id,text) VALUES ('remaining',${cardId},'old-owner','남은 질문')`;
    await h.sql`UPDATE cards SET assignee_session_id='new-owner' WHERE id=${cardId}`;
    messages.mockClear();
    await cards.answerQuestion({...human,cardId,questionId:String(question.id),answer:'첫 답'});await dispatcher.drain();
    expect((await cards.getCard(cardId))?.card).toMatchObject({status:'blocked',blocked_kind:'question'});
    expect(messages).toHaveBeenCalledWith('new-owner',expect.any(String),undefined,
      expect.objectContaining({deliveryId:expect.stringMatching(new RegExp(`^card:${cardId}:answer:[^:]+:new-owner$`))}));
    expect(messages.mock.calls[0]![1]).toBe(`[카드 질문 답변] 카드 「커멘트 대상」(${cardId})`
      + `\n질문: 이전 담당 질문\n질문 ID: ${String(question.id)}\n글 답: 첫 답\n카드 상태: 막힘`);
    expect(String((await h.sql`SELECT session_id FROM card_questions WHERE id=${String(question.id)}`)[0]!.session_id)).toBe('old-owner');
    messages.mockClear();
    const answer={...human,cardId,questionId:'remaining',answer:'마지막 답',idempotencyKey:key()};
    await cards.answerQuestion(answer);await dispatcher.drain();await cards.answerQuestion(answer);await dispatcher.drain();
    expect(messages).toHaveBeenCalledTimes(2);
    expect(messages.mock.calls.map(c=>c[0])).toEqual(['new-owner','new-owner']);
    expect(messages.mock.calls[1]![1]).toBe(`사용자가 카드 「커멘트 대상」(${cardId})를 막힘→실행 중으로 변경했습니다`
      + `\n[카드 질문 답변] 카드 「커멘트 대상」(${cardId})`
      + `\n질문: 남은 질문\n질문 ID: remaining\n글 답: 마지막 답\n카드 상태: 실행 중`);
    expect((await cards.getCard(cardId))?.card.status).toBe('running');
  });

  it("blocks replaced sessions from brief, question, and spoken writes while preserving allowed actors", async () => {
    const cardId = await makeCard("담당 교체 쓰기 차단");
    await h.sql`INSERT INTO sessions(session_id,folder_id,card_id,status) VALUES
      ('old-owner','comment-folder',${cardId},'running'),('new-owner','comment-folder',${cardId},'running')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_session_id='new-owner' WHERE id=${cardId}`;
    const oldOwner = { actorKind: "agent" as const, actorSessionId: "old-owner", cardId };
    const message = "다른 세션이 담당인 카드입니다. 인계 요약, 질문, 발언 기록은 담당 세션만 씁니다.";

    await expect(cards.updateCardBrief({ ...oldOwner, brief: "옛 요약" }))
      .rejects.toMatchObject({ statusCode: 422, code: "INVALID_CARD_REQUEST", message });
    await expect(cards.askQuestion({ ...oldOwner, text: "옛 질문", options: ["진행"] }))
      .rejects.toMatchObject({ statusCode: 422, code: "INVALID_CARD_REQUEST", message });
    await expect(cards.addComment({ ...oldOwner, body: "옛 발언", mode: "spoken" }))
      .rejects.toMatchObject({ statusCode: 422, code: "INVALID_CARD_REQUEST", message });

    const server = app();
    try {
      const response = await server.inject({ method: "POST", url: `/api/cards/${cardId}/comments`,
        headers: { authorization: "Bearer service-test", "x-soulstream-agent-session-id": "old-owner" },
        payload: { body: "HTTP 옛 발언", mode: "spoken", idempotencyKey: key() } });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ detail: { error: { code: "INVALID_CARD_REQUEST", message } } });
    } finally { await server.close(); }

    const newOwner = { actorKind: "agent" as const, actorSessionId: "new-owner", cardId };
    const briefMutation = await cards.updateCardBrief({ ...newOwner, brief: "새 요약" });
    expect(briefMutation.operation.operation_type).toBe("update_card");
    await cards.askQuestion({ ...newOwner, text: "새 질문", options: ["진행"], idempotencyKey: key() });
    await cards.addComment({ ...newOwner, body: "새 발언", mode: "spoken", idempotencyKey: key() });
    await cards.updateCardBrief({ ...human, cardId, brief: "사용자 요약" });
    await cards.askQuestion({ ...human, cardId, text: "사용자 질문", options: ["진행"], idempotencyKey: key() });
    await cards.addComment({ ...human, cardId, body: "사용자 커멘트", idempotencyKey: key() });

    const unassignedCardId = await makeCard("담당 없는 카드");
    const unassignedActor = { actorKind: "agent" as const, actorSessionId: "old-owner", cardId: unassignedCardId };
    await cards.updateCardBrief({ ...unassignedActor, brief: "드래프트 요약" });
    await cards.askQuestion({ ...unassignedActor, text: "드래프트 질문", options: ["진행"], idempotencyKey: key() });
    await cards.addComment({ ...unassignedActor, body: "드래프트 발언", mode: "spoken", idempotencyKey: key() });

    expect((await cards.getCard(cardId))?.card.brief).toBe("사용자 요약");
    expect((await cards.getCard(cardId))?.comments.map(comment => comment.body)).toEqual(["새 발언", "사용자 커멘트"]);
    expect((await cards.getCard(unassignedCardId))?.comments.map(comment => comment.body)).toEqual(["드래프트 발언"]);
  });

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

  it("delivers a completed card's user comment to its owner without reopening the card",async()=>{
    const cardId=await makeCard();
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('owner','completed')`;
    await h.sql`UPDATE cards SET status='done',assignee_kind='session',assignee_session_id='owner' WHERE id=${cardId}`;
    const comment=await cards.addComment({...human,cardId,body:'보완해 주세요',idempotencyKey:key()});
    await dispatcher.drain();
    expect(messages).toHaveBeenCalledWith('owner',expect.stringContaining('보완해 주세요'),undefined,expect.objectContaining({actorKind:'user'}));
    const detail=(await cards.getCard(cardId))!;
    expect(detail.card.status).toBe('done');
    expect(detail.comments.find(c=>c.id===comment.id)!.delivered_at).toBeInstanceOf(Date);
  });

  it("stores an assignee reply as agent in review without delivery or status change", async () => {
    const cardId = await makeCard("에이전트 답변");
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('reply-owner','running')`;
    await h.sql`UPDATE cards SET status='review',assignee_kind='session',assignee_session_id='reply-owner' WHERE id=${cardId}`;
    const before = (await cards.getCard(cardId))!.card;
    const server = app();
    try {
      const input = { body: "확인한 결과입니다", mode: "reply", idempotencyKey: key() };
      const options = { method: "POST" as const, url: `/api/cards/${cardId}/comments`,
        headers: { authorization: "Bearer service-test", "x-soulstream-agent-session-id": "reply-owner" }, payload: input };
      const posted = await server.inject(options);
      expect(posted.statusCode).toBe(201);
      expect(posted.json()).toMatchObject({ authorKind: "agent", authorId: null, sessionId: "reply-owner", kind: "comment", body: input.body });
      expect((await server.inject(options)).json().id).toBe(posted.json().id);
      await h.sql`INSERT INTO sessions(session_id,status) VALUES ('reply-other','running')`;
      const impersonation = await server.inject({ ...options,
        headers: { authorization: "Bearer service-test", "x-soulstream-agent-session-id": "reply-other" } });
      expect(impersonation.statusCode).toBeGreaterThanOrEqual(400);
      await dispatcher.drain();
      const detail = (await cards.getCard(cardId))!;
      expect(detail.card).toMatchObject({ status: "review", version: before.version });
      expect(detail.comments).toEqual([expect.objectContaining({ author_kind: "agent", session_id: "reply-owner", kind: "comment", body: input.body, delivered_at: null })]);
      expect(messages).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it("rejects human, untrusted header and another session reply impersonation", async () => {
    const cardId = await makeCard();
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('reply-owner','running'),('reply-other','running')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_session_id='reply-owner' WHERE id=${cardId}`;
    const server = app();
    try {
      for (const headers of [
        {},
        { "x-soulstream-agent-session-id": "reply-owner" },
        { authorization: "Bearer service-test", "x-soulstream-agent-session-id": "reply-other" },
      ]) {
        const result = await server.inject({ method: "POST", url: `/api/cards/${cardId}/comments`, headers,
          payload: { body: "사칭 답변", mode: "reply", idempotencyKey: key() } });
        expect(result.statusCode).toBeGreaterThanOrEqual(400);
      }
      expect((await cards.getCard(cardId))!.comments).toEqual([]);
    } finally { await server.close(); }
  });

  it.each([
    { target: "assigned", actor: "self", kind: "spoken", expected: 0 },
    { target: "assigned", actor: "self", kind: "comment", expected: 0 },
    { target: "assigned", actor: "other", kind: "spoken", expected: 0 },
    { target: "fallback", actor: "self", kind: "spoken", expected: 0 },
    { target: "fallback", actor: "self", kind: "comment", expected: 0 },
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
    if (target === "assigned" && actor === "other" && kind === "spoken") {
      await expect(cards.addComment(input)).rejects.toMatchObject({
        statusCode: 422, code: "INVALID_CARD_REQUEST",
        message: "다른 세션이 담당인 카드입니다. 인계 요약, 질문, 발언 기록은 담당 세션만 씁니다.",
      });
      expect((await cards.getCard(cardId))!.comments).toEqual([]);
      return;
    }
    const posted = await cards.addComment(input);
    const retried = await cards.addComment(input);
    expect(retried.id).toBe(posted.id);
    await dispatcher.drain();
    expect(messages).toHaveBeenCalledTimes(expected);
    if (expected) expect(messages).toHaveBeenCalledWith("target-session", expect.stringContaining(input.body),undefined,expect.objectContaining({deliveryId:expect.stringContaining(":comment:"),actorKind:input.actorKind,actorSessionId:input.actorSessionId}));
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
      expect(messages).toHaveBeenCalledWith("assigned-session", expect.stringContaining("사용자가 카드 「커멘트 대상」"),undefined,expect.objectContaining({deliveryId:expect.stringContaining(":comment:")}));
      const detail = await server.inject(`/api/cards/${cardId}`);
      expect(detail.json().comments).toEqual([expect.objectContaining({ body: "고정된 지시", authorKind: "user", kind: "comment" })]);
      const stored = await h.sql<{ delivered_at: Date | null }[]>`SELECT delivered_at FROM card_comments WHERE card_id=${cardId}`;
      expect(stored[0]!.delivered_at).toBeInstanceOf(Date);
      const comments = await h.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM card_comments WHERE card_id=${cardId}`;
      expect(comments[0]!.count).toBe(1);
    } finally { await server.close(); }
  });

  it("delivers the comment ID, targeted item, and confirmations since the prior delivered comment",async()=>{
    const cardId=await makeCard();
    await h.sql`INSERT INTO sessions(session_id,folder_id,card_id,status) VALUES ('item-owner','comment-folder',${cardId},'running')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_session_id='item-owner' WHERE id=${cardId}`;
    await cards.setCardItems({actorKind:'agent',actorSessionId:'item-owner',cardId,items:['로그인 완료','검색 결과']});
    await cards.confirmCardItem({...human,cardId,itemId:1,confirmed:true});
    await cards.confirmCardItem({...human,cardId,itemId:2,confirmed:true});
    await cards.confirmCardItem({...human,cardId,itemId:1,confirmed:false});
    const comment=await cards.addComment({...human,cardId,itemId:1,body:'로그인 화면을 다시 확인해 주세요',idempotencyKey:key()});
    await dispatcher.drain();
    expect(messages).toHaveBeenCalledOnce();
    const text=messages.mock.calls[0]![1];
    expect(text).toContain(`커멘트 ID: ${comment.id}`);
    expect(text).toContain('대상 항목: 1번 로그인 완료');
    expect(text).toContain('그동안 확인한 항목: 1번, 2번');
    expect((await cards.getCard(cardId))!.comments[0]!.delivered_at).toBeInstanceOf(Date);
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
      expect(messages).toHaveBeenCalledWith("latest-dispatch", expect.stringContaining("사용자가 카드 「최근 dispatch」"),undefined,expect.objectContaining({deliveryId:expect.stringContaining(":comment:")}));
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

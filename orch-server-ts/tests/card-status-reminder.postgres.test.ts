import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect, vi } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { prepareCardWorkSchema, appendCardEventTx, recordWorkReceipt } from "./card-work-postgres-fixture.js";
import { prepareCardReminderSchema } from "./card-reminder-postgres-fixture.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService, type CardMutationChange } from "../src/cards/card_control_plane_service.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { CardDispatcher, type CardDispatcherOptions } from "../src/cards/card_dispatcher.js";

// Reuses card-work-start's actual event receipts and card-comments' dispatcher port seam.
describe("durable card status reminders", () => {
  let h: PagePostgresHarness, sql: ReturnType<typeof createFolderContentSqlAdapter>, cards: CardControlPlaneService;
  let repo: CardDispatchRepository, dispatcher: CardDispatcher;
  let now: number;
  const origin = Date.parse("2026-10-03T08:00:00Z");
  const messages = vi.fn<CardDispatcherOptions["sendMessage"]>();
  const warn = vi.fn(), kick = vi.fn(async () => {});
  const human = { actorKind: "user" as const, actorSessionId: null };
  const makeDispatcher = () => new CardDispatcher({ repository: repo, cards: async () => cards,
    resolveTarget: vi.fn() as never, launch: vi.fn(), notify: vi.fn(), sendMessage: messages, warn,
    deliveryExists: async (id: string) => (await h.sql`SELECT delivery_id FROM session_deliveries WHERE delivery_id=${id}`).length > 0,
    abandonDelivery: async () => {},
    now: () => now, orchestration: { enabled: async () => true, kick, ownsSession: async () => false } } as CardDispatcherOptions);
  beforeAll(async () => {
    h = await createPagePostgresHarness(); await prepareCardWorkSchema(h); await prepareCardReminderSchema(h);
    await h.sql`INSERT INTO folders(id,name) VALUES ('f','폴더')`;
    sql = createFolderContentSqlAdapter(h.liveSql);
    repo = new CardDispatchRepository(async () => sql);
  }, 60000);
  beforeEach(async () => {
    await dispatcher?.drain();
    await h.sql`TRUNCATE sessions,folder_operations,session_delivery_relation_consumptions RESTART IDENTITY CASCADE`;
    await h.sql`DELETE FROM cards`;
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status) VALUES ('root','node','roselin','running'),('child','node','roselin','running'),('grand','node','roselin','running')`;
    now = origin; warn.mockReset(); kick.mockClear(); messages.mockReset();
    messages.mockImplementation(async (sessionId, _text, _admission, delivery) => {
      expect(delivery).toMatchObject({ actorKind: "system", actorSessionId: null });
      await h.sql`INSERT INTO session_deliveries(delivery_id,target_session_id,relation_key,intent,source,payload_hash,state,aggregate_state,created_at)
        VALUES (${delivery!.deliveryId},${sessionId},${delivery!.deliveryId},'durable_next_turn','card_change',${"a".repeat(64)},'pending','pending',${new Date(now)})`;
    });
    cards = new CardControlPlaneService(sql, { appendEventTx: appendCardEventTx });
    dispatcher = makeDispatcher();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await dispatcher?.drain(); await h?.cleanup(); });
  async function receipt(sessionId: string, status = "completed", age = 60000, reason: string | null = null) {
    const id = await recordWorkReceipt(h, sessionId, status, undefined, reason);
    await h.sql`UPDATE event_ingress_receipts SET created_at=${new Date(now - age)} WHERE session_id=${sessionId} AND event_id=${id}`;
    return id;
  }
  async function seed(status = "running", childStatus?: string, rootStatus = "completed", reason: string | null = null) {
    const id = (await cards.createCard({ ...human, folderId: "f", title: "원문", request: "요청", assignee: { kind: "session", sessionId: "root" } })).operation.target_id;
    await h.sql`UPDATE cards SET status=${status},status_changed_at=${new Date(now - 3600000)} WHERE id=${id}`;
    // The assigned root need not have sessions.card_id; a child is found by caller linkage.
    await h.sql`UPDATE sessions SET caller_session_id=${childStatus ? "root" : null} WHERE session_id='child'`;
    if (childStatus) await h.sql`UPDATE sessions SET status=${childStatus} WHERE session_id='child'`;
    await receipt("root", rootStatus, 60000, reason);
    return id;
  }
  async function deliveredComment(cardId: string, body: string, idempotencyKey: string) {
    const comment = await cards.addComment({ ...human, cardId, body, idempotencyKey });
    const id = String(comment.id);
    await cards.markCommentDelivered(cardId, id);
    return { id };
  }
  async function tick() { now += 60000; await dispatcher.tick(); await dispatcher.drain(); }
  async function notice(eventId: number, aggregate = "pending", age = 0) {
    await h.sql`INSERT INTO session_deliveries(delivery_id,target_session_id,relation_key,intent,source,payload_hash,state,aggregate_state,created_at)
      VALUES ('notice','root',${`child_session:child:${eventId}`},'durable_next_turn','child_session_completion',${"a".repeat(64)},${aggregate === "pending" ? "pending" : aggregate === "consumed" ? "consumed" : "uncertain"},${aggregate},${new Date(now - age)})`;
  }
  async function unchanged(id: string, status: string) { expect((await cards.getCard(id))!.card.status).toBe(status); expect(warn).not.toHaveBeenCalled(); }
  const ownerSilentCalls = () => messages.mock.calls.filter(([, , , delivery]) => delivery?.deliveryId?.includes(":owner_silent:"));
  async function consume(deliveryId?: string) {
    if (deliveryId) await h.sql`UPDATE session_deliveries SET state='consumed',aggregate_state='consumed' WHERE delivery_id=${deliveryId}`;
    else await h.sql`UPDATE session_deliveries SET state='consumed',aggregate_state='consumed'`;
  }
  const ownerSilentText = (number: number, id: string, lastTurnEnd: string) => `[카드 상태 확인] 카드 #${number} 「원문」(${id})는 진행 중인데 담당 세션이 30분 넘게 턴을 마친 채이고, 돌고 있는 하위 세션도 예약된 깨움도 없습니다. 마지막 턴 종료: ${lastTurnEnd}. 기다리는 것이 있으면 무엇인지와 그것이 실제로 올 수 있는지 확인하세요. 끝난 하위 세션은 스스로 다시 보고하지 않습니다(완료 알림에 「이어서 다시 보고합니다」가 있던 경우만 예외). 올 수 없으면 결과를 직접 확인해 이어 가고, 정한 시각에 다시 볼 일이면 검증 대기(깨울 시각과 기다리는 것)로, 남이 풀어 줄 일이면 막힘으로 옮기세요. 이대로 30분이 더 지나면 카드를 막힘으로 옮깁니다.`;
  it("skips reminder facts for updates of a running root", async () => {
    const id = await seed("running", undefined, "running");
    const facts = vi.spyOn(repo, "reminderFacts");
    await dispatcher.sessionEnded("root");
    expect(facts).not.toHaveBeenCalled();
    expect(kick).toHaveBeenCalled();
    await unchanged(id, "running");
  });
  it("continues existing terminal processing when reminder facts fail", async () => {
    const id = await seed();
    vi.spyOn(repo, "reminderFacts").mockRejectedValue(new Error("reminder facts unavailable"));
    const endedWork = vi.spyOn(repo, "endedWork"), terminal = vi.spyOn(repo, "session");
    await dispatcher.sessionEnded("root");
    expect(endedWork).toHaveBeenCalledWith("root");
    expect(terminal).toHaveBeenCalledWith("root");
    expect(kick).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("reminder facts unavailable"));
    expect((await cards.getCard(id))!.card.status).toBe("running");
  });
  it("not_running sends once, includes the existing status label, and sends again only after status changes", async () => {
    const id = await seed("review", "running");
    await dispatcher.sessionEnded("root"); await dispatcher.sessionEnded("root");
    expect(messages).toHaveBeenCalledTimes(1);
    expect(messages.mock.calls[0]![1]).toBe(`[카드 상태 확인] 카드 ${id}는 '검수'인데, 담당 세션이 턴을 마친 뒤에도 맡긴 작업 세션이 돌고 있습니다.`);
    expect(messages.mock.calls[0]![3]!.deliveryId).toBe(`card-reminder:${id}:not_running:${(origin - 3600000) * 1000}:root`);
    await cards.setCardStatus({ ...human, cardId: id, status: "blocked" });
    await dispatcher.sessionEnded("root"); expect(messages).toHaveBeenCalledTimes(2);
    await unchanged(id, "blocked");
  });
  it("reminds once when a delivered user comment has no later card change", async () => {
    const id = await seed("review", undefined, "running");
    const comment = await deliveredComment(id, "수정해 주세요", "unhandled-comment");
    await receipt("root");
    await dispatcher.sessionEnded("root");
    await dispatcher.sessionEnded("root");
    expect(messages).toHaveBeenCalledTimes(1);
    expect(messages.mock.calls[0]![0]).toBe("root");
    expect(messages.mock.calls[0]![1]).toBe(`[카드 상태 확인] 카드 ${id}는 '검수'인데, 사용자 커멘트(ID ${comment.id})가 전달된 뒤 카드 상태, 항목, 커멘트에 바뀐 것이 없습니다. 수정 지시였으면 항목을 하는 중으로 알리고 카드를 진행 중으로 옮긴 뒤 진행하고, 질문이었으면 답 커멘트를 남기세요.`);
    expect(messages.mock.calls[0]![3]!.deliveryId).toBe(`card-reminder:${id}:comment_unhandled:${comment.id}:root`);
    await unchanged(id, "review");
  });
  it("does not remind after the assigned session replies to the delivered comment", async () => {
    const id = await seed("review", undefined, "running");
    await deliveredComment(id, "질문이 있습니다", "answered-comment");
    await cards.addComment({ actorKind: "agent", actorSessionId: "root", cardId: id, body: "확인했습니다", mode: "reply", idempotencyKey: "comment-reply" });
    await receipt("root");
    await dispatcher.sessionEnded("root");
    expect(messages).not.toHaveBeenCalled();
    await unchanged(id, "review");
  });
  it("does not remind after the assigned session changes card status", async () => {
    const id = await seed("review", undefined, "running");
    await deliveredComment(id, "검수가 끝났습니다", "handled-by-status");
    await cards.setCardStatus({ actorKind: "agent", actorSessionId: "root", cardId: id, status: "done" });
    await receipt("root");
    await dispatcher.sessionEnded("root");
    expect(messages).not.toHaveBeenCalled();
    await unchanged(id, "done");
  });
  it("does not remind while a delivery to the card tree is still pending", async () => {
    const id = await seed("review", undefined, "running");
    await deliveredComment(id, "반영해 주세요", "pending-delivery-comment");
    await notice(await receipt("child"));
    await receipt("root");
    await dispatcher.sessionEnded("root");
    expect(messages).not.toHaveBeenCalled();
    await unchanged(id, "review");
  });
  it("does not remind for an undelivered latest user comment", async () => {
    const id = await seed("review", undefined, "running");
    await deliveredComment(id, "이전 요청", "older-delivered-comment");
    const latest = await cards.addComment({ ...human, cardId: id, body: "새 요청", idempotencyKey: "latest-undelivered-comment" });
    const latestId = String(latest.id);
    await h.sql`UPDATE card_comments SET created_at=created_at+INTERVAL '1 second' WHERE id=${latestId}`;
    await receipt("root");
    await dispatcher.sessionEnded("root");
    expect(messages).not.toHaveBeenCalled();
    await unchanged(id, "review");
  });
  it.each([["review", "interrupted", null], ["review", "error", "limit_hit"], ["running", "completed", null], ["review", "running", null]])("not_running excludes card=%s root=%s reason=%s", async (status, rootStatus, reason) => {
    const id = await seed(status!, "initializing", rootStatus!, reason); await dispatcher.sessionEnded("root");
    expect(messages).not.toHaveBeenCalled(); await unchanged(id, status!);
  });
  it("prunes another card's owner and its whole branch, but includes owners of archived cards", async () => {
    const id = await seed("review", "completed");
    await h.sql`UPDATE sessions SET caller_session_id='child' WHERE session_id='grand'`;
    const other = (await cards.createCard({ ...human, folderId: "f", title: "다른 카드", request: "", assignee: { kind: "session", sessionId: "child" } })).operation.target_id;
    await dispatcher.sessionEnded("root"); expect(messages).not.toHaveBeenCalled();
    await cards.patchCard({ ...human, cardId: other, archived: true });
    await dispatcher.sessionEnded("root"); expect(messages).toHaveBeenCalledTimes(1); await unchanged(id, "review");
  });
  it("uses the latest eligible unclaimed root and never wakes a same-card child", async () => {
    const id = await seed("review", "running");
    await cards.patchCard({ ...human, cardId: id, assignee: { kind: "agent", agentId: "roselin" } });
    await h.sql`UPDATE sessions SET card_id=${id} WHERE session_id IN ('root','child')`;
    await dispatcher.sessionEnded("child"); expect(messages).not.toHaveBeenCalled();
    await dispatcher.sessionEnded("root"); expect(messages.mock.calls[0]![0]).toBe("root"); await unchanged(id, "review");
  });
  it.each(["completed", "error"])("stalled sends to a %s root after its status clock", async status => {
    const id = await seed("running", undefined, status); await dispatcher.sessionEnded("root");
    expect(messages).toHaveBeenCalledTimes(1);
    expect(messages.mock.calls[0]![1]).toBe(`[카드 상태 확인] 카드 ${id}는 진행 중인데 담당 세션과 맡긴 작업 세션이 모두 멈췄습니다.`);
    expect(messages.mock.calls[0]![3]!.deliveryId).toContain(":stalled:"); await unchanged(id, "running");
  });
  it.each(["interrupted", "limit", "active", "older", "archived"])("stalled excludes %s", async kind => {
    const id = await seed("running", kind === "active" ? "initializing" : undefined, kind === "interrupted" ? "interrupted" : kind === "limit" ? "error" : "completed", kind === "limit" ? "limit_hit" : null);
    if (kind === "older") await h.sql`UPDATE event_ingress_receipts SET created_at=${new Date(now - 7200000)} WHERE session_id='root'`;
    if (kind === "archived") await cards.patchCard({ ...human, cardId: id, archived: true });
    await dispatcher.sessionEnded("root"); await tick(); expect(messages).not.toHaveBeenCalled(); await unchanged(id, "running");
  });
  it("holds an unregistered child completion for five minutes, then treats it as lost", async () => {
    const id = await seed("running", "completed"); await receipt("child");
    await tick(); expect(messages).not.toHaveBeenCalled();
    now += 5 * 60000; await tick(); expect(messages).toHaveBeenCalledTimes(1); await unchanged(id, "running");
  });
  it.each(["consumed", "dead_letter", "expired"])("pending notification suppresses stalled until %s", async kind => {
    const id = await seed("running", "completed"), eventId = await receipt("child"); await notice(eventId);
    await tick(); expect(messages).not.toHaveBeenCalled();
    if (kind === "expired") now += 30 * 60000;
    else await h.sql`UPDATE session_deliveries SET aggregate_state=${kind},state=${kind === "consumed" ? "consumed" : "uncertain"}`;
    await tick(); expect(messages).toHaveBeenCalledTimes(1); await unchanged(id, "running");
  });
  it.each(["inline", "quiet"])("does not await already consumed or excluded child completion: %s", async kind => {
    const id = await seed("running", "completed"), eventId = await receipt("child");
    if (kind === "inline") await h.sql`INSERT INTO session_delivery_relation_consumptions(relation_key,completion_id,caller_session_id,consumed_turn_id) VALUES (${`child_session:child:${eventId}`},'completion','root','turn')`;
    if (kind === "quiet") await h.sql`UPDATE sessions SET notify_completion=FALSE WHERE session_id='child'`;
    await tick(); expect(messages).toHaveBeenCalledTimes(1); await unchanged(id, "running");
  });
  it("awaits a human-stopped child completion like any registered completion", async () => {
    // card #1261: user_stop도 이제 완료 통지를 등록하므로 미등록 5분 보류 규칙을 똑같이 받는다.
    const id = await seed("running", "completed");
    await h.sql`UPDATE sessions SET termination_detail='user_stop' WHERE session_id='child'`;
    await receipt("child");
    await tick(); expect(messages).not.toHaveBeenCalled();
    now += 5 * 60000; await tick(); expect(messages).toHaveBeenCalledTimes(1); await unchanged(id, "running");
  });
  it("consumption, brief, same status, a resumed root and dispatcher restart never repeat the same reminder", async () => {
    const id = await seed(); await tick(); expect(messages).toHaveBeenCalledTimes(1);
    await h.sql`UPDATE session_deliveries SET state='consumed',aggregate_state='consumed'`;
    await cards.patchCard({ ...human, cardId: id, brief: "경과" }); await cards.setCardStatus({ ...human, cardId: id, status: "running" });
    await receipt("root"); await dispatcher.sessionEnded("root"); dispatcher = makeDispatcher(); await tick();
    expect(messages).toHaveBeenCalledTimes(1); await unchanged(id, "running");
  });
  it("enabled-policy tick attempts at most two reminders and sends the remaining one next tick", async () => {
    const ids = [await seed()];
    for (const n of [2, 3]) {
      const sid = `root${n}`; await h.sql`INSERT INTO sessions(session_id,node_id,status) VALUES (${sid},'node','completed')`;
      const id = (await cards.createCard({ ...human, folderId: "f", title: sid, request: "", assignee: { kind: "session", sessionId: sid } })).operation.target_id;
      await h.sql`UPDATE cards SET status='running',status_changed_at=${new Date(now - 3600000)} WHERE id=${id}`; await receipt(sid); ids.push(id);
    }
    await tick(); expect(messages).toHaveBeenCalledTimes(2); expect(kick).toHaveBeenCalled();
    await tick(); expect(messages).toHaveBeenCalledTimes(3); for (const id of ids) await unchanged(id, "running");
  });
  it.each([
    ["end", "register", "resume", "tick"], ["tick", "end", "register", "resume"],
    ["resume", "register", "tick", "end"], ["register", "tick", "end", "resume"],
  ])("settles arrival permutation %j without changing card state", async (...order) => {
    const id = await seed("running", "running");
    const eventId = await receipt("child"); await h.sql`UPDATE sessions SET status='running',termination_event_id=NULL WHERE session_id='child'`;
    for (const step of order) {
      if (step === "end") { await h.sql`UPDATE sessions SET status='completed',termination_event_id=${eventId} WHERE session_id='child'`; await dispatcher.sessionEnded("child"); }
      if (step === "register") await notice(eventId);
      if (step === "resume") { await receipt("root", "running"); await dispatcher.sessionEnded("root"); await receipt("root"); await dispatcher.sessionEnded("root"); }
      if (step === "tick") await tick();
    }
    expect(messages).not.toHaveBeenCalled();
    await h.sql`UPDATE session_deliveries SET state='consumed',aggregate_state='consumed' WHERE delivery_id='notice'`;
    await tick(); await tick(); expect(messages).toHaveBeenCalledTimes(1); expect(messages.mock.calls[0]![0]).toBe("root"); await unchanged(id, "running");
  });
  it("wakes a silent owner once after thirty minutes and never twice for the same turn end", async () => {
    const id = await seed();
    await tick();                                            // 기존 stalled가 상태 세대마다 한 번 나간다
    expect(ownerSilentCalls()).toHaveLength(0);
    await consume();
    const turnEnd = await receipt("root", "completed", 0);   // 담당이 턴을 마쳤다
    await dispatcher.sessionEnded("root");
    now += 29 * 60000; await dispatcher.tick(); await dispatcher.drain();
    expect(ownerSilentCalls()).toHaveLength(0);
    now += 2 * 60000; await dispatcher.tick(); await dispatcher.drain();
    expect(ownerSilentCalls()).toHaveLength(1);
    expect(ownerSilentCalls()[0]![0]).toBe("root");
    expect(ownerSilentCalls()[0]![1]).toBe(ownerSilentText((await cards.getCard(id))!.card.number!, id, "17:01"));
    expect(ownerSilentCalls()[0]![3]!.deliveryId).toBe(`card-reminder:${id}:owner_silent:${turnEnd}:root`);
    now += 60000; await dispatcher.tick(); await dispatcher.drain();
    expect(ownerSilentCalls()).toHaveLength(1);
    await unchanged(id, "running");
  });
  it("blocks the card without report and sends the board notice when the woken owner stays silent", async () => {
    const changes: CardMutationChange[] = [];
    cards = new CardControlPlaneService(sql, { appendEventTx: appendCardEventTx }, undefined, change => changes.push(change));
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,metadata) VALUES ('pas','node','roselin','completed',${h.sql.json([{ type: "persistent_session", value: { enabled: true } }])})`;
    const id = (await cards.createCard({ actorKind: "agent", actorSessionId: "pas", actorUserId: null, folderId: "f", title: "원문", request: "요청", assignee: { kind: "session", sessionId: "root" } })).operation.target_id;
    await h.sql`UPDATE cards SET status='running',status_changed_at=${new Date(now - 3600000)} WHERE id=${id}`;
    await receipt("root", "completed", 60000);
    changes.length = 0;

    await tick(); await consume();                           // 기존 stalled를 받아 갔고 깨움은 아직이다
    await receipt("root", "completed", 0); await dispatcher.sessionEnded("root");
    now += 31 * 60000; await dispatcher.tick(); await dispatcher.drain();
    expect(ownerSilentCalls()).toHaveLength(1);
    await consume();                                         // 담당이 깨움을 받아 갔다

    now += 60000; await receipt("root", "completed", 0); await dispatcher.sessionEnded("root");   // 응답 턴 종료
    now += 31 * 60000; await dispatcher.tick(); await dispatcher.drain();

    const card = (await cards.getCard(id))!.card;
    expect(card.status).toBe("blocked");
    expect(card.blocked_kind).toBe("no_report");
    expect(card.blocked_detail).toBe("담당이 턴을 마친 채 30분이 지나 깨웠지만, 그 뒤 30분 동안 움직임이 없음");
    expect(card.now?.text).toBe(card.blocked_detail);
    expect(ownerSilentCalls()).toHaveLength(1);              // 두 번째는 깨움이 아니라 막힘이다
    for (const change of changes) if (change.result.operation.operation_type === "set_card_status") dispatcher.acceptMutation(change);
    await dispatcher.drain();
    const board = messages.mock.calls.filter(([sessionId, text]) => sessionId === "pas" && String(text).startsWith("[카드 막힘]"));
    expect(board).toHaveLength(1);
    expect(board[0]![1]).toContain("사유: 담당이 턴을 마친 채 30분이 지나 깨웠지만, 그 뒤 30분 동안 움직임이 없음(no_report)");
  });
  it("starts again from the wake when a different delivery woke the owner", async () => {
    const id = await seed();
    await tick(); await consume();
    await receipt("root", "completed", 0); await dispatcher.sessionEnded("root");
    now += 31 * 60000; await dispatcher.tick(); await dispatcher.drain();
    expect(ownerSilentCalls()).toHaveLength(1);
    await consume();

    now += 60000;
    const childEvent = await receipt("child", "completed", 0);
    await notice(childEvent);                                // 하위 세션 완료 알림이 담당을 깨웠다
    now += 60000;
    const turnEnd = await receipt("root", "completed", 0); await dispatcher.sessionEnded("root");
    now += 31 * 60000; await dispatcher.tick(); await dispatcher.drain();

    expect(ownerSilentCalls()).toHaveLength(2);
    expect(ownerSilentCalls()[1]![3]!.deliveryId).toBe(`card-reminder:${id}:owner_silent:${turnEnd}:root`);
    expect(ownerSilentCalls()[1]![3]!.deliveryId).not.toBe(ownerSilentCalls()[0]![3]!.deliveryId);
    await unchanged(id, "running");
  });
  it.each(["active-child", "pending-delivery", "awaiting-verification", "limit-hit"])("keeps both owner silent steps out for %s", async kind => {
    let id: string, status = "running";
    if (kind === "active-child") { id = await seed("running", "running"); now += 31 * 60000; await dispatcher.tick(); await dispatcher.drain(); }
    else if (kind === "pending-delivery") {
      id = await seed(); now += 31 * 60000;
      await notice(await receipt("child", "completed", 0));
      await dispatcher.tick(); await dispatcher.drain();
    } else if (kind === "awaiting-verification") {
      id = await seed(); status = "awaiting_verification";
      await h.sql`UPDATE cards SET status='awaiting_verification',wake_at=${new Date(now + 3600000)},waiting_for='검증' WHERE id=${id}`;
      now += 31 * 60000; await dispatcher.tick(); await dispatcher.drain();
    } else { id = await seed("running", undefined, "error", "limit_hit"); now += 31 * 60000; await dispatcher.tick(); await dispatcher.drain(); }
    expect(ownerSilentCalls()).toHaveLength(0);
    await unchanged(id, status);
  });
});

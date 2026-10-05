import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect, vi } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { prepareCardWorkSchema, appendCardEventTx, recordWorkReceipt } from "./card-work-postgres-fixture.js";
import { prepareCardReminderSchema } from "./card-reminder-postgres-fixture.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { CardDispatcher, type CardDispatcherOptions } from "../src/cards/card_dispatcher.js";

// Reuses card-work-start's actual event receipts and card-comments' dispatcher port seam.
describe("durable card status reminders", () => {
  let h: PagePostgresHarness, cards: CardControlPlaneService, repo: CardDispatchRepository, dispatcher: CardDispatcher;
  let now: number;
  const origin = Date.parse("2026-10-03T08:00:00Z");
  const messages = vi.fn<CardDispatcherOptions["sendMessage"]>();
  const warn = vi.fn(), kick = vi.fn(async () => {});
  const human = { actorKind: "user" as const, actorSessionId: null };
  const makeDispatcher = () => new CardDispatcher({ repository: repo, cards: async () => cards,
    resolveTarget: vi.fn() as never, launch: vi.fn(), notify: vi.fn(), sendMessage: messages, warn,
    deliveryExists: async (id: string) => (await h.sql`SELECT delivery_id FROM session_deliveries WHERE delivery_id=${id}`).length > 0,
    now: () => now, orchestration: { enabled: async () => true, kick, ownsSession: async () => false } } as CardDispatcherOptions);
  beforeAll(async () => {
    h = await createPagePostgresHarness(); await prepareCardWorkSchema(h); await prepareCardReminderSchema(h);
    await h.sql`INSERT INTO folders(id,name) VALUES ('f','폴더')`;
    const sql = createBoardYjsSqlAdapter(h.liveSql);
    repo = new CardDispatchRepository(async () => sql);
    cards = new CardControlPlaneService(sql, { appendEventTx: appendCardEventTx });
  }, 60000);
  beforeEach(async () => {
    await dispatcher?.drain();
    await h.sql`TRUNCATE sessions,folder_operations,session_delivery_relation_consumptions RESTART IDENTITY CASCADE`;
    await h.sql`DELETE FROM cards`;
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status) VALUES ('root','node','roselin','running'),('child','node','roselin','running'),('grand','node','roselin','running')`;
    now = origin; warn.mockReset(); kick.mockClear(); messages.mockReset();
    messages.mockImplementation(async (sessionId, _text, _admission, delivery) => {
      expect(delivery).toMatchObject({ actorKind: "system", actorSessionId: null });
      await h.sql`INSERT INTO session_deliveries(delivery_id,target_session_id,relation_key,intent,source,payload_hash,state,aggregate_state)
        VALUES (${delivery!.deliveryId},${sessionId},${delivery!.deliveryId},'durable_next_turn','card_change',${"a".repeat(64)},'pending','pending')`;
    });
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
  async function tick() { now += 60000; await dispatcher.tick(); await dispatcher.drain(); }
  async function notice(eventId: number, aggregate = "pending", age = 0) {
    await h.sql`INSERT INTO session_deliveries(delivery_id,target_session_id,relation_key,intent,source,payload_hash,state,aggregate_state,created_at)
      VALUES ('notice','root',${`child_session:child:${eventId}`},'durable_next_turn','child_session_completion',${"a".repeat(64)},${aggregate === "pending" ? "pending" : aggregate === "consumed" ? "consumed" : "uncertain"},${aggregate},${new Date(now - age)})`;
  }
  async function unchanged(id: string, status: string) { expect((await cards.getCard(id))!.card.status).toBe(status); expect(warn).not.toHaveBeenCalled(); }
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
    expect(messages.mock.calls[0]![1]).toContain("카드는 '검수'입니다");
    expect(messages.mock.calls[0]![3]!.deliveryId).toBe(`card-reminder:${id}:not_running:${(origin - 3600000) * 1000}:root`);
    await cards.setCardStatus({ ...human, cardId: id, status: "blocked" });
    await dispatcher.sessionEnded("root"); expect(messages).toHaveBeenCalledTimes(2);
    await unchanged(id, "blocked");
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
    expect(messages.mock.calls[0]![1]).toContain("확인 항목에 결과를 달고 request_card_review의 ask");
    expect(messages.mock.calls[0]![1]).toContain("확인 항목이 없는 옛 카드는 기존 보고");
    expect(messages.mock.calls[0]![1]).toContain("update_card_now");
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
  it.each(["inline", "quiet", "user_stop"])("does not await already consumed or excluded child completion: %s", async kind => {
    const id = await seed("running", "completed"), eventId = await receipt("child");
    if (kind === "inline") await h.sql`INSERT INTO session_delivery_relation_consumptions(relation_key,completion_id,caller_session_id,consumed_turn_id) VALUES (${`child_session:child:${eventId}`},'completion','root','turn')`;
    if (kind === "quiet") await h.sql`UPDATE sessions SET notify_completion=FALSE WHERE session_id='child'`;
    if (kind === "user_stop") await h.sql`UPDATE sessions SET termination_detail='user_stop' WHERE session_id='child'`;
    await tick(); expect(messages).toHaveBeenCalledTimes(1); await unchanged(id, "running");
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
});

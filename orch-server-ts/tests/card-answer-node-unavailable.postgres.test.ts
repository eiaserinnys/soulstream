import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { prepareCardReminderSchema } from "./card-reminder-postgres-fixture.js";
import { appendCardEventTx, prepareCardWorkSchema } from "./card-work-postgres-fixture.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService, type CardMutationChange } from "../src/cards/card_control_plane_service.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { CardDispatcher, type CardDispatcherOptions } from "../src/cards/card_dispatcher.js";
import { sendCardChangeOnce } from "../src/cards/card_change_delivery.js";
import { SessionDeliveryRepository } from "../src/control_plane/repositories/session_delivery_repository.js";
import { intervenePayload } from "../src/session/session_action_command_payloads.js";
import { SessionRouteNodeUnavailableError } from "../src/session/session_command_router.js";

// Disposable DB with the real control plane, dispatcher and delivery ledger.
// Only the transport is a stand-in: it mimics the production sendMessage branch
// in card_dispatch_runtime.ts and always reports the target node as gone.
describe("an answer that leaves the card status unchanged survives an unavailable node", () => {
  let h: PagePostgresHarness;
  let cards: CardControlPlaneService;
  let dispatcher: CardDispatcher;
  let deliveries: SessionDeliveryRepository;
  const human = { actorKind: "user" as const, actorSessionId: null };
  // Production sendMessage builds the same wire delivery fields for a
  // changeDelivery and routes it through sendCardChangeOnce; a message without
  // one goes straight to the router and leaves no delivery record. The router
  // always fails here, as it does while the node is away.
  const messages = vi.fn<CardDispatcherOptions["sendMessage"]>(async (sessionId, text, _admission, changeDelivery) => {
    const parsed = intervenePayload(sessionId, {
      text,
      ...(changeDelivery ? { delivery_id: changeDelivery.deliveryId, delivery_intent: "durable_next_turn",
        source: "card_change", relation_key: changeDelivery.deliveryId, completion_id: changeDelivery.deliveryId } : {}),
      caller_info: changeDelivery ? { source: changeDelivery.actorKind === "user" ? "browser" : changeDelivery.actorKind === "agent" ? "agent" : "system",
        ...(changeDelivery.actorSessionId ? { session_id: changeDelivery.actorSessionId } : {}) } : { source: "system" },
    });
    if (!parsed.ok) throw new Error(parsed.message);
    const send = async () => {
      throw new SessionRouteNodeUnavailableError({ agentSessionId: sessionId, nodeId: "node" });
    };
    if (changeDelivery) return sendCardChangeOnce(deliveries, parsed.value, send);
    await send();
  });
  const warn = vi.fn();
  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await prepareCardReminderSchema(h);
    const schema = await readFile(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8");
    await h.sql.unsafe(schema.match(/CREATE TABLE IF NOT EXISTS session_delivery_attempts \([\s\S]*?\n\);/)![0]);
    await h.sql`INSERT INTO folders(id,name) VALUES('answer-folder','답변')`;
    const sql = createFolderContentSqlAdapter(h.liveSql);
    deliveries = new SessionDeliveryRepository(h.liveSql as never);
    cards = new CardControlPlaneService(sql, { appendEventTx: appendCardEventTx }, undefined,
      (change: CardMutationChange) => dispatcher.acceptMutation(change));
    dispatcher = new CardDispatcher({ repository: new CardDispatchRepository(async () => sql), cards: async () => cards,
      resolveTarget: () => ({ nodeId: "node", agentId: "worker", modelPreset: "model", available: true, reason: null }),
      launch: async () => {}, sendMessage: messages, notify: async () => {}, deliveryExists: async () => false,
      abandonDelivery: async () => {}, warn });
  }, 60_000);
  beforeEach(async () => {
    await dispatcher.drain();
    await h.sql`DELETE FROM session_deliveries`;
    await h.sql`DELETE FROM card_questions`;
    await h.sql`DELETE FROM card_reports`;
    await h.sql`DELETE FROM folder_operations`;
    await h.sql`DELETE FROM cards`;
    await h.sql`DELETE FROM sessions`;
    messages.mockClear(); warn.mockClear();
  });
  afterAll(async () => { await dispatcher?.drain(); await h?.cleanup(); });

  it("records the answer delivery and a returning node claims it", async () => {
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status) VALUES ('owner','node','worker','running')`;
    const id = (await cards.createCard({ ...human, folderId: "answer-folder", title: "질문 둘", request: "수행",
      assignee: { kind: "session", sessionId: "owner" }, nodeId: "node" })).operation.target_id;
    await cards.setCardStatus({ ...human, cardId: id, status: "running" });
    await cards.askQuestion({ actorKind: "agent", actorSessionId: "owner", cardId: id, text: "첫 질문", options: ["진행"] });
    await h.sql`INSERT INTO card_questions(id,card_id,session_id,text) VALUES ('remaining',${id},'owner','남은 질문')`;
    await dispatcher.drain();
    expect((await cards.getCard(id))!.card).toMatchObject({ status: "blocked", blocked_kind: "question" });
    messages.mockClear();
    // Drop the setup's own delivery attempt so only the answer is under test.
    await h.sql`DELETE FROM session_deliveries`;

    const answered = (await cards.getCard(id))!.questions.find(q => q.text === "첫 질문")!;
    await cards.answerQuestion({ ...human, cardId: id, questionId: String(answered.id), answer: "첫 답" });
    await dispatcher.drain();

    // The other question still blocks the card, so no state change notification exists.
    expect((await cards.getCard(id))!.card).toMatchObject({ status: "blocked", blocked_kind: "question" });
    const rows = await h.sql<{delivery_id:string;aggregate_state:string}[]>`
      SELECT delivery_id,aggregate_state FROM session_deliveries WHERE target_session_id='owner'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delivery_id).toMatch(new RegExp(`^card:${id}:answer:[^:]+:owner$`));
    expect(rows[0]!.aggregate_state).not.toBe("consumed");

    // Node returns: the failed attempt expires and the pending intent is claimed.
    const deliveryId = rows[0]!.delivery_id;
    await h.sql`UPDATE session_deliveries SET attempt_expires_at=NOW()-INTERVAL '1 second',
      next_attempt_at=NOW()-INTERVAL '1 second' WHERE delivery_id=${deliveryId}`;
    expect(await deliveries.expireStaleDeliveryAttempts()).toBe(1);
    // The retry backoff schedules the next attempt a moment out; the returning
    // node is here now, so pull it back instead of waiting.
    await h.sql`UPDATE session_deliveries SET next_attempt_at=NOW()-INTERVAL '1 second' WHERE delivery_id=${deliveryId}`;
    const claimed = await deliveries.recovery.claimPendingImmediateIntentsForNode("node", "returning-node-token");
    expect(claimed.map(row => row.delivery_id)).toEqual([deliveryId]);
    const text = String(claimed[0]!.payload.text);
    expect(text).toContain("[카드 질문 답변]");
    expect(text).toContain("글 답: 첫 답");
  });
});

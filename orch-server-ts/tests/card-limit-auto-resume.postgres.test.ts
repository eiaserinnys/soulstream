import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { prepareCardReminderSchema } from "./card-reminder-postgres-fixture.js";
import { appendCardEventTx, prepareCardWorkSchema, recordWorkReceipt } from "./card-work-postgres-fixture.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";
import { CardOrchestrationCoordinator } from "../src/cards/card_orchestration_coordinator.js";
import { CardOrchestrationRepository } from "../src/cards/card_orchestration_repository.js";
import { readCardOrchestrationSettings } from "../src/cards/card_orchestration_settings.js";
import { resolveCardSessionTarget } from "../src/cards/card_session_target.js";
import { SessionDeliveryRepository } from "../src/control_plane/repositories/session_delivery_repository.js";

// Disposable DB, real card mutations, real dispatcher and real control plane.
// Only message transport, model availability and notifications are mocked.
describe("short quota windows resume the card assignee automatically", () => {
  const HOUR = 60 * 60 * 1000;
  const BASE = Date.parse("2026-11-07T05:00:00.000Z"); // 14:00 Asia/Seoul
  let h: PagePostgresHarness, cards: CardControlPlaneService, repo: CardDispatchRepository;
  let dispatcher!: CardDispatcher, deliveries: SessionDeliveryRepository;
  let clock = BASE, available = true;
  const human = { actorKind: "user" as const, actorSessionId: null };
  const execution = { registrationId: "owner-registration", executionCommandId: "owner-command" };
  const messages = vi.fn(async (_sessionId: string, _text: string, _admission?: unknown,
    _changeDelivery?: { deliveryId: string }) => {});
  const launch = vi.fn(async () => {}), warn = vi.fn();
  const target = () => ({ nodeId: "node", agentId: "worker", modelPreset: "model",
    available, reason: available ? null : "quota" });

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await prepareCardReminderSchema(h);
    await h.sql`INSERT INTO folders(id,name) VALUES('limit-folder','한도')`;
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
    await h.sql`INSERT INTO system_settings(setting_key,value,updated_by) VALUES('card_dispatch','{"nodeConcurrency":{"default":2}}','test')`;
    await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/113_card_orchestration.sql", import.meta.url), "utf8"));
    const schema = await readFile(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8");
    await h.sql.unsafe(schema.match(/CREATE TABLE IF NOT EXISTS session_delivery_attempts \([\s\S]*?\n\);/)![0]);
    await h.sql.unsafe(schema.match(/CREATE TABLE IF NOT EXISTS session_delivery_notification_outbox \([\s\S]*?\n\);/)![0]);
    await h.sql.unsafe(schema.match(/ALTER TABLE session_delivery_notification_outbox\n    ADD COLUMN IF NOT EXISTS projection_state[\s\S]*?;/)![0]);
    await h.sql`UPDATE system_settings SET value=jsonb_set(value,'{enabled}','true') WHERE setting_key='card_orchestration'`;
    const sql = createBoardYjsSqlAdapter(h.liveSql);
    deliveries = new SessionDeliveryRepository(h.liveSql as never);
    cards = new CardControlPlaneService(sql, { appendEventTx: appendCardEventTx }, undefined,
      change => dispatcher.acceptMutation(change));
    repo = new CardDispatchRepository(async () => sql);
    dispatcher = new CardDispatcher({ repository: repo, cards: async () => cards, resolveTarget: target,
      launch, sendMessage: messages, notify: async () => {}, deliveryExists: async () => false, warn,
      abandonDelivery: async (deliveryId, reason) => { await deliveries.markUncertain(deliveryId, undefined, reason); },
      now: () => clock,
      orchestration: { enabled: async () => true, kick: async () => {}, ownsSession: async () => false } });
  }, 60000);
  beforeEach(async () => {
    await dispatcher.drain();
    await h.sql`DELETE FROM card_orchestration_dispatches`;
    await h.sql`DELETE FROM card_orchestration_runs`;
    await h.sql`DELETE FROM card_questions`;
    await h.sql`DELETE FROM card_reports`;
    await h.sql`DELETE FROM card_execution_requests`;
    await h.sql`DELETE FROM session_deliveries`;
    await h.sql`DELETE FROM folder_operations`;
    await h.sql`DELETE FROM cards`;
    await h.sql`DELETE FROM sessions`;
    await h.sql`UPDATE card_orchestration_state SET state='off',reason=NULL,last_decision_input_hash=NULL,
      provision_id=NULL,provision_request=NULL,resolved_folder_id=NULL WHERE id=TRUE`;
    await h.sql`UPDATE system_settings SET value=jsonb_set(value,'{enabled}','true') WHERE setting_key='card_orchestration'`;
    await h.sql`UPDATE system_settings SET value='{"nodeConcurrency":{"default":2}}' WHERE setting_key='card_dispatch'`;
    clock = BASE;
    available = true;
    messages.mockClear(); launch.mockClear(); warn.mockClear();
  });
  afterAll(async () => { await dispatcher?.drain(); await h?.cleanup(); });

  async function appendEvent(sessionId: string, eventType: string, payload: unknown, createdAt: Date) {
    const rows = await h.sql<{ id: number }[]>`SELECT event_append(${sessionId},${eventType},
      ${JSON.stringify(payload)},'fixture',${createdAt.toISOString()},NULL) AS id`;
    return rows[0]!.id;
  }
  async function makeCard() {
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,model_preset,status) VALUES
      ('pas','pas-node','supervisor','pas-model','running'),
      ('owner','node','worker','model','running')`;
    await h.sql`UPDATE sessions SET metadata=${h.sql.json([{ type: "persistent_session", value: { enabled: true } }])}
      WHERE session_id='pas'`;
    await recordWorkReceipt(h, "owner", "running", execution);
    const id = (await cards.createCard({ actorKind: "agent", actorSessionId: "pas", folderId: "limit-folder",
      title: "요청", request: "실행", assignee: { kind: "session", sessionId: "owner" },
      nodeId: "node", modelPreset: "model" })).operation.target_id;
    await h.sql`UPDATE sessions SET card_id=${id} WHERE session_id='owner'`;
    await cards.startCardWork({ actorKind: "agent", actorSessionId: "owner", cardId: id, expectedVersion: 1, execution });
    await dispatcher.drain();
    return id;
  }
  async function limitHit(endedAt: number, resetsAt: number | null) {
    await recordWorkReceipt(h, "owner", "error", null, "limit_hit");
    if (resetsAt !== null)
      await appendEvent("owner", "credential_alert", { status: "rejected", resets_at: new Date(resetsAt).toISOString() },
        new Date(endedAt - 60_000));
    const terminalId = await appendEvent("owner", "session_ended", { termination_reason: "limit_hit" }, new Date(endedAt));
    await h.sql`UPDATE sessions SET termination_event_id=${terminalId} WHERE session_id='owner'`;
    dispatcher.accept([{ type: "node_session_session_updated", nodeId: "node", committedIngress: true,
      data: { agentSessionId: "owner" } }]);
    await dispatcher.drain();
    return terminalId;
  }
  function makeCoordinator() {
    const sql = createBoardYjsSqlAdapter(h.liveSql);
    const orchestration = new CardOrchestrationRepository(async () => sql);
    const judge = { agentId: "judge", nodeId: "node", modelPreset: "judge-model", minimumRemainingPercent: 15 };
    return new CardOrchestrationCoordinator({ repository: orchestration, dispatch: repo, cards: async () => cards,
      settings: async () => readCardOrchestrationSettings(sql), resolveTarget: target,
      resolveSessionTarget: async card => {
        const resolved = await resolveCardSessionTarget(card, id => repo.ownerSession(id), () => ({ available, reason: null }));
        return { nodeId: resolved.nodeId ?? "", agentId: resolved.agentId ?? "", modelPreset: resolved.modelPreset ?? null,
          sessionId: resolved.sessionId ?? undefined, available: resolved.available, reason: resolved.reason };
      },
      selectOrchestrator: async () => ({ candidate: judge, reason: null, instructionsRevision: "revision" }),
      ensureFolder: async () => "limit-folder", launchDecision: async () => {}, launchWorker: launch,
      sendMessage: messages, warn });
  }
  const limitNotices = () => messages.mock.calls.filter(call => String(call[1]).startsWith("[카드 막힘]"));
  const resumeDeliveries = () => messages.mock.calls.filter(call =>
    String(call[3]?.deliveryId ?? "").startsWith("card-limit-resume:"));

  it("A: records the reset clock, the board now and no PAS block notice", async () => {
    const id = await makeCard();
    await limitHit(BASE, BASE + 3 * HOUR);
    const card = (await cards.getCard(id))!.card;
    expect(card).toMatchObject({ status: "blocked", blocked_kind: "limit",
      blocked_detail: "사용량 한도, 17:00 자동 재개" });
    expect(card.now).toMatchObject({ text: "사용량 한도로 멈춤, 17:00에 저절로 이어집니다", turn: "outside" });
    expect(messages).not.toHaveBeenCalled();
  });

  it("B: does nothing before the reset and is not an orchestration candidate", async () => {
    const id = await makeCard();
    await limitHit(BASE, BASE + 3 * HOUR);
    messages.mockClear();
    const before = (await cards.getCard(id))!.card;
    clock = BASE + HOUR;
    await dispatcher.checkLimits(); await dispatcher.drain();
    expect(messages).not.toHaveBeenCalled();
    expect((await cards.getCard(id))!.card).toMatchObject({ status: "blocked", blocked_kind: "limit",
      version: before.version });
    await makeCoordinator().kick();
    const state = (await h.sql<{ state: string; reason: string | null }[]>`
      SELECT state,reason FROM card_orchestration_state WHERE id=TRUE`)[0]!;
    expect(state.state).toBe("skipped");
    expect(state.reason).toContain("limit_auto_resume");
  });

  it("C: delivers exactly once after the reset and resumes the card", async () => {
    const id = await makeCard();
    await limitHit(BASE, BASE + 3 * HOUR);
    messages.mockClear();
    clock = BASE + 3 * HOUR + 1000;
    await dispatcher.checkLimits(); await dispatcher.drain();
    expect(messages).toHaveBeenCalledTimes(1);
    const wakes = resumeDeliveries();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]![0]).toBe("owner");
    expect(wakes[0]![1]).toBe("한도가 풀려 재개한다. 첫 행동은 WIP 커밋이다.");
    expect((await cards.getCard(id))!.card).toMatchObject({ status: "running", blocked_kind: null,
      blocked_detail: null, queue_position_key: null });
    expect((await cards.getCard(id))!.card.now).toMatchObject({ text: "담당이 이어서 진행합니다", turn: "agent" });
    const sent = messages.mock.calls.length;
    await dispatcher.checkLimits(); await dispatcher.drain();
    expect(messages.mock.calls.length).toBe(sent);
  });

  it("D: never wakes the former owner after a transfer", async () => {
    const id = await makeCard();
    await limitHit(BASE, BASE + 3 * HOUR);
    await h.sql`INSERT INTO sessions(session_id,card_id,node_id,agent_id,model_preset,status)
      VALUES('replacement',${id},'node','worker','model','running')`;
    await cards.patchCard({ ...human, cardId: id, assignee: { kind: "session", sessionId: "replacement" } });
    await dispatcher.drain();
    messages.mockClear();
    clock = BASE + 3 * HOUR + 1000;
    await dispatcher.checkLimits(); await dispatcher.drain();
    expect(messages.mock.calls.filter(call => call[0] === "owner")).toHaveLength(0);
    expect(resumeDeliveries()).toHaveLength(0);
    expect((await cards.getCard(id))!.card.assignee_session_id).toBe("replacement");
  });

  it("D: skips a card whose replacement is waiting for an execution result", async () => {
    const id = await makeCard();
    await limitHit(BASE, BASE + 3 * HOUR);
    await h.sql`INSERT INTO card_execution_requests(id,idempotency_key,keys,card_id,session_id,mode,target,previous_status)
      VALUES('pending-replacement','pending-replacement',${h.sql.json([])},${id},'replacement','resume',
        ${h.sql.json({})},'blocked')`;
    messages.mockClear();
    const before = (await cards.getCard(id))!.card;
    clock = BASE + 3 * HOUR + 1000;
    await dispatcher.checkLimits(); await dispatcher.drain();
    expect(messages).not.toHaveBeenCalled();
    expect((await cards.getCard(id))!.card).toMatchObject({ status: "blocked", blocked_kind: "limit",
      version: before.version });
  });

  it.each(["done", "cancelled", "on_hold"] as const)("E: never wakes the owner after the card is %s", async status => {
    const id = await makeCard();
    await limitHit(BASE, BASE + 3 * HOUR);
    await cards.setCardStatus({ ...human, cardId: id, status,
      expectedVersion: (await cards.getCard(id))!.card.version });
    await dispatcher.drain();
    messages.mockClear();
    clock = BASE + 3 * HOUR + 1000;
    await dispatcher.checkLimits(); await dispatcher.drain();
    expect(messages).not.toHaveBeenCalled();
    expect((await cards.getCard(id))!.card.status).toBe(status);
  });

  it("F: leaves a reset beyond five hours manual and keeps the PAS notice", async () => {
    const id = await makeCard();
    await limitHit(BASE, BASE + 78 * HOUR);
    expect((await cards.getCard(id))!.card).toMatchObject({ status: "blocked", blocked_kind: "limit",
      blocked_detail: "세션 사용량 한도" });
    expect(limitNotices()).toHaveLength(1);
    expect(limitNotices()[0]![0]).toBe("pas");
    messages.mockClear();
    clock = BASE + 79 * HOUR;
    await dispatcher.checkLimits(); await dispatcher.drain();
    expect(messages).not.toHaveBeenCalled();
    expect((await cards.getCard(id))!.card.status).toBe("blocked");
  });

  it("G: waits again after a second limit and resumes at the new reset", async () => {
    const id = await makeCard();
    await limitHit(BASE, BASE + 3 * HOUR);
    clock = BASE + 3 * HOUR + 1000;
    await dispatcher.checkLimits(); await dispatcher.drain();
    expect(resumeDeliveries()).toHaveLength(1);
    const endedAt = BASE + 4 * HOUR, resetsAt = endedAt + 2 * HOUR;
    await limitHit(endedAt, resetsAt);
    expect((await cards.getCard(id))!.card).toMatchObject({ status: "blocked", blocked_kind: "limit",
      blocked_detail: "사용량 한도, 20:00 자동 재개" });
    clock = resetsAt - 1000;
    await dispatcher.checkLimits(); await dispatcher.drain();
    expect(messages).toHaveBeenCalledTimes(1);
    expect(resumeDeliveries()).toHaveLength(1);
    clock = resetsAt + 1000;
    await dispatcher.checkLimits(); await dispatcher.drain();
    expect(messages).toHaveBeenCalledTimes(2);
    expect(resumeDeliveries()).toHaveLength(2);
    expect((await cards.getCard(id))!.card.status).toBe("running");
  });

  it("H: abandons the failed delivery and retries with a new id", async () => {
    const id = await makeCard();
    await limitHit(BASE, BASE + 3 * HOUR);
    messages.mockClear();
    messages.mockRejectedValueOnce(new Error("bridge down"));
    clock = BASE + 3 * HOUR + 1000;
    await dispatcher.checkLimits(); await dispatcher.drain();
    expect(warn).toHaveBeenCalled();
    expect((await cards.getCard(id))!.card).toMatchObject({ status: "blocked", blocked_kind: "limit" });
    await dispatcher.checkLimits(); await dispatcher.drain();
    const wakes = resumeDeliveries();
    expect(wakes).toHaveLength(2);
    expect(wakes[0]![3]?.deliveryId).not.toBe(wakes[1]![3]?.deliveryId);
    expect((await cards.getCard(id))!.card.status).toBe("running");
  });

  it("I: leaves the card untouched while the model is unavailable", async () => {
    const id = await makeCard();
    await limitHit(BASE, BASE + 3 * HOUR);
    messages.mockClear();
    const before = (await cards.getCard(id))!.card;
    available = false;
    clock = BASE + 3 * HOUR + 1000;
    await dispatcher.checkLimits(); await dispatcher.drain();
    expect(messages).not.toHaveBeenCalled();
    expect((await cards.getCard(id))!.card).toMatchObject({ status: "blocked", blocked_kind: "limit",
      version: before.version });
  });

  it("J: resumes an owner that is already awake without a delivery", async () => {
    const id = await makeCard();
    await limitHit(BASE, BASE + 3 * HOUR);
    await h.sql`UPDATE sessions SET status='running' WHERE session_id='owner'`;
    messages.mockClear();
    await dispatcher.checkLimits(); await dispatcher.drain();
    expect(resumeDeliveries()).toHaveLength(0);
    expect((await cards.getCard(id))!.card).toMatchObject({ status: "running", blocked_kind: null });
  });

  it("K: ignores a reset that precedes the termination", async () => {
    const id = await makeCard();
    await limitHit(BASE, BASE - HOUR);
    expect((await cards.getCard(id))!.card.blocked_detail).toBe("세션 사용량 한도");
    messages.mockClear();
    clock = BASE + HOUR;
    await dispatcher.checkLimits(); await dispatcher.drain();
    expect(messages).not.toHaveBeenCalled();
    expect((await cards.getCard(id))!.card.status).toBe("blocked");
  });

  it("L: an abandoned resume delivery is never replayed on reconnect", async () => {
    const id = await makeCard();
    const deliveryId = `card-limit-resume:${id}:424242:${Date.now()}`;
    await deliveries.register({ deliveryId, targetSessionId: "owner", relationKey: deliveryId,
      completionId: deliveryId, intent: "durable_next_turn", source: "card_change",
      payloadHash: "a".repeat(64), payload: { text: "한도가 풀려 재개한다." } });
    expect(await deliveries.claim(deliveryId, "card-change:token", 0)).not.toBeNull();
    await deliveries.markUncertain(deliveryId, undefined, "sendMessage failed: bridge down");
    expect((await deliveries.get(deliveryId))?.aggregate_state).toBe("dead_letter");
    await deliveries.expireStaleDeliveryAttempts();
    const claimed = await deliveries.recovery.claimPendingImmediateIntentsForNode("node", "recovery-token");
    expect(claimed.map(row => row.delivery_id)).not.toContain(deliveryId);
  });
});

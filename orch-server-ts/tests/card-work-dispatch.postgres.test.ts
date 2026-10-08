import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardExecutionService } from "../src/cards/card_execution_service.js";
import type { DispatchWorkInput } from "../src/cards/card_work_dispatch_service.js";
import { CardWorkDispatchService } from "../src/cards/card_work_dispatch_service.js";
import {
  canonicalWorkErrorDeliveryId,
  recordConfirmedErrorTx,
  relayCanonicalErrorTx,
} from "../src/cards/card_work_error_delivery.js";
import type { RepositorySql } from "../src/cards/control_plane/card_types.js";
import type { SessionDeliveryRow } from "../src/control_plane/control_plane_types.js";
import {
  appendCardEventTx,
  prepareCardWorkSchema,
  recordWorkReceipt,
} from "./card-work-postgres-fixture.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

const actor = { actorKind: "agent" as const, actorSessionId: "caller-session" };
const createInput = (idempotencyKey: string, overrides: Partial<Extract<DispatchWorkInput, { kind: "create" }>> = {}): Extract<DispatchWorkInput, { kind: "create" }> => ({
  kind: "create" as const,
  request: "원문 요청",
  brief: "완료 기준",
  title: "접수 카드",
  idempotencyKey,
  ...overrides,
});

function createStack(options: { allowFolder?: (folderId: string) => boolean; launch?: (input: unknown) => Promise<unknown> } = {}) {
  const sql = createBoardYjsSqlAdapter(h.liveSql);
  const cards = new CardControlPlaneService(sql, { appendEventTx: appendCardEventTx });
  const launch = vi.fn(options.launch ?? (async () => undefined));
  const execution = new CardExecutionService({
    sql,
    cards,
    validate: async (card) => ({
      nodeId: card.node_id ?? "node-a",
      agentId: card.assignee_agent_id ?? "agent-a",
      modelPreset: card.model_preset,
    }),
    launch,
    ensure: async () => ({
      state: "already_running" as const,
      execution: { registrationId: "registered", executionCommandId: "command" },
    }),
  });
  const optionsForService = {
    sql,
    cards,
    execution,
    authorizeFolder: async (folderId: string) => {
      if (!(options.allowFolder ?? ((id) => id === "work"))(folderId)) {
        throw Object.assign(new Error("Folder access denied"), { statusCode: 403 });
      }
    },
    sendDelivery: vi.fn(async (_row: SessionDeliveryRow) => undefined),
    emitCardUpdated: vi.fn(),
    warn: vi.fn(),
  };
  return {
    sql,
    cards,
    execution,
    launch,
    optionsForService,
    service: new CardWorkDispatchService(optionsForService),
  };
}

let h: PagePostgresHarness;
beforeAll(async () => {
  h = await createPagePostgresHarness();
  await prepareCardWorkSchema(h);
  await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/116_card_execution_requests.sql", import.meta.url), "utf8"));
  await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
  await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/113_card_orchestration.sql", import.meta.url), "utf8"));
  await h.sql`INSERT INTO folders(id,name) VALUES ('work','작업'),('restricted','제한'),('claude','Claude'),('llm','LLM')`;
  await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,folder_id,model_preset)
    VALUES ('caller-session','node-a','agent-a','running','work','model-a')`;
}, 60000);
afterAll(async () => h?.cleanup());

describe("card work dispatch transaction contracts", () => {
  it("commits create and reservation before kick, replays the same receipt, and rejects changed input", async () => {
    let releaseLaunch!: () => void;
    let signalLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    const launchStarted = new Promise<void>((resolve) => { signalLaunch = resolve; });
    const stack = createStack({ launch: async () => { signalLaunch(); await launchGate; } });
    const input = createInput("create-replay");

    const receipt = await stack.service.accept(input, actor);
    expect(receipt).toMatchObject({ accepted: true, idempotent: false, work: { kind: "execution" } });
    expect(receipt.card.number === null || typeof receipt.card.number === "number").toBe(true);
    if (receipt.work.kind !== "execution") throw new Error("Expected execution receipt");
    const stored = await h.sql`SELECT c.request,c.brief,c.folder_id,c.assignee_agent_id,c.node_id,c.model_preset,r.id,r.session_id,r.state,r.target
      FROM cards c JOIN card_execution_requests r ON r.card_id=c.id WHERE c.id=${receipt.card.id}`;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ request: "원문 요청", brief: "완료 기준", folder_id: "work", assignee_agent_id: "agent-a", node_id: "node-a", model_preset: "model-a", id: receipt.work.requestId, session_id: receipt.work.sessionId, state: "pending" });

    await h.sql`UPDATE sessions SET folder_id='restricted',node_id='node-changed',agent_id='agent-changed',model_preset='model-changed' WHERE session_id='caller-session'`;
    const [replayA, replayB] = await Promise.all([
      stack.service.accept(input, actor),
      stack.service.accept(input, actor),
    ]);
    expect(replayA).toMatchObject({ ...receipt, idempotent: true });
    expect(replayB).toMatchObject({ ...receipt, idempotent: true });
    expect(replayA.work).toEqual(receipt.work);
    expect(await h.sql`SELECT id FROM folder_operations WHERE idempotency_key='dispatch-work:caller-session:create-replay'`).toHaveLength(1);
    await expect(stack.service.accept(createInput("create-replay", { request: "다른 원문" }), actor)).rejects.toMatchObject({ statusCode: 409 });

    const kicking = stack.service.kick(receipt);
    await launchStarted;
    expect(receipt.accepted).toBe(true);
    expect(stack.launch).toHaveBeenCalledTimes(1);
    releaseLaunch();
    await kicking;
    expect(await h.sql`SELECT delivery_id FROM session_deliveries WHERE source='card_change' AND producer_id=${receipt.operationId}` ).toHaveLength(0);
    await h.sql`UPDATE sessions SET folder_id='work',node_id='node-a',agent_id='agent-a',model_preset='model-a' WHERE session_id='caller-session'`;
  }, 60000);

  it("rolls back card and reservation together and rejects unauthorized or system-folder defaults", async () => {
    const base = createStack();
    const rollbackInput = createInput("rollback-card", { title: "롤백 전용 카드" });
    const brokenExecution = {
      reserveTx: async (tx: RepositorySql, params: Parameters<CardExecutionService["reserveTx"]>[1]) => {
        await base.execution.reserveTx(tx, params);
        throw new Error("injected reservation failure");
      },
      startReserved: (requestId: string, dispatchActor: Parameters<CardExecutionService["startReserved"]>[1]) =>
        base.execution.startReserved(requestId, dispatchActor),
    };
    const broken = new CardWorkDispatchService({ ...base.optionsForService, execution: brokenExecution });
    await expect(broken.accept(rollbackInput, actor)).rejects.toThrow("injected reservation failure");
    expect(await h.sql`SELECT id FROM cards WHERE title='롤백 전용 카드' AND request='원문 요청'`).toHaveLength(0);
    expect(await h.sql`SELECT id FROM folder_operations WHERE idempotency_key='dispatch-work:caller-session:rollback-card'`).toHaveLength(0);
    expect(await h.sql`SELECT id FROM card_execution_requests WHERE idempotency_key=(
      SELECT 'dispatch-work-execution:'||id FROM folder_operations WHERE idempotency_key='dispatch-work:caller-session:rollback-card')`).toHaveLength(0);

    const denied = createStack({ allowFolder: (folderId) => folderId === "work" });
    await expect(denied.service.accept(createInput("acl-denied", { folderId: "restricted" }), actor)).rejects.toMatchObject({ statusCode: 403 });
    expect(await h.sql`SELECT id FROM folder_operations WHERE idempotency_key='dispatch-work:caller-session:acl-denied'`).toHaveLength(0);

    await h.sql`UPDATE sessions SET folder_id='claude' WHERE session_id='caller-session'`;
    await expect(denied.service.accept(createInput("system-default"), actor)).rejects.toThrow();
    expect(await h.sql`SELECT id FROM folder_operations WHERE idempotency_key='dispatch-work:caller-session:system-default'`).toHaveLength(0);
    await h.sql`UPDATE sessions SET folder_id='work' WHERE session_id='caller-session'`;
  }, 60000);

  it("stores a spoken followup and its saved delivery atomically, then replays and marks only an accepted delivery", async () => {
    const stack = createStack();
    const made = await stack.cards.createCard({
      actorKind: "user", actorSessionId: null, actorUserId: "user",
      folderId: "work", title: "담당 카드", request: "기존 요청",
      assignee: { kind: "agent", agentId: "owner-agent" }, nodeId: "node-a", modelPreset: "model-a",
    });
    const cardId = made.operation.target_id;
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,folder_id,model_preset)
      VALUES ('owner-session','node-a','owner-agent','completed',${cardId},'work','owner-model')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_agent_id=NULL,assignee_session_id='owner-session' WHERE id=${cardId}`;

    const input = { kind: "followup" as const, cardId, request: "다음 지시", brief: "확인할 결과", idempotencyKey: "followup-replay" };
    const receipt = await stack.service.accept(input, actor);
    expect(receipt).toMatchObject({ accepted: true, idempotent: false, work: { kind: "delivery", sessionId: "owner-session" } });
    if (receipt.work.kind !== "delivery") throw new Error("Expected delivery receipt");
    const expectedComment = "요청 원문:\n다음 지시\n\n필요한 맥락과 완료기준:\n확인할 결과";
    const savedComment = await h.sql`SELECT author_kind,session_id,kind,body,delivered_at FROM card_comments WHERE card_id=${cardId}`;
    expect(savedComment).toEqual([{ author_kind: "user", session_id: "caller-session", kind: "spoken", body: expectedComment, delivered_at: null }]);
    const deliveryRows = await h.sql`SELECT * FROM session_deliveries WHERE delivery_id=${receipt.work.deliveryId}`;
    expect(deliveryRows).toHaveLength(1);
    expect(deliveryRows[0]).toMatchObject({ target_session_id: "owner-session", source_session_id: "caller-session", producer_id: receipt.operationId, source: "card_change", intent: "durable_next_turn", state: "pending" });
    expect(deliveryRows[0]!.payload.text).toContain(expectedComment);
    expect(deliveryRows[0]!.payload.caller_info).toEqual({ source: "agent", session_id: "caller-session" });
    expect(stack.optionsForService.emitCardUpdated).toHaveBeenCalledTimes(1);

    const replay = await stack.service.accept(input, actor);
    expect(replay).toMatchObject({ ...receipt, idempotent: true });
    expect(replay.work).toEqual(receipt.work);
    expect(await h.sql`SELECT id FROM card_comments WHERE card_id=${cardId}`).toHaveLength(1);
    expect(await h.sql`SELECT delivery_id FROM session_deliveries WHERE producer_id=${receipt.operationId} AND producer_kind IS NULL`).toHaveLength(1);
    expect(stack.optionsForService.emitCardUpdated).toHaveBeenCalledTimes(1);

    const deliveryError = await h.sql.begin((tx) => recordConfirmedErrorTx(tx, {
      operationId: receipt.operationId,
      cardId,
      workId: receipt.work.kind === "delivery" ? receipt.work.deliveryId : "",
      stage: "delivery",
      message: "전달이 명시적으로 거부됐습니다",
      failureId: "delivery-ack-rejected",
    }));
    expect(deliveryError).not.toBeNull();
    const replayAfterError = await stack.service.accept(input, actor);
    expect(replayAfterError.idempotent).toBe(true);
    expect(replayAfterError.work).toEqual(receipt.work);
    expect(await h.sql`SELECT delivery_id FROM session_deliveries WHERE producer_id=${receipt.operationId}`).toHaveLength(2);

    const deliveryWorkId = receipt.work.deliveryId;
    const savedPayload = deliveryRows[0]!.payload as Record<string, unknown>;
    stack.optionsForService.sendDelivery.mockImplementation(async (row) => {
      expect(row.delivery_id).toBe(deliveryWorkId);
      expect(row.payload).toEqual(savedPayload);
      await h.sql`UPDATE session_deliveries SET state='queued',queued_at=NOW(),updated_at=NOW() WHERE delivery_id=${row.delivery_id}`;
    });
    await stack.service.kick(receipt);
    const marked = await h.sql`SELECT delivered_at FROM card_comments WHERE card_id=${cardId}`;
    expect(marked[0]!.delivered_at).not.toBeNull();
  }, 60000);

  it("records only confirmed errors for the operation actor and relays an exact canonical execution failure", async () => {
    const stack = createStack();
    const receipt = await stack.service.accept(createInput("error-relay"), actor);
    if (receipt.work.kind !== "execution") throw new Error("Expected execution receipt");
    const failure = {
      operationId: receipt.operationId,
      cardId: receipt.card.id,
      workId: receipt.work.requestId,
      stage: "launch" as const,
      message: "노드가 명시적으로 거부했습니다",
      failureId: "ack:node-rejected",
    };
    const first = await stack.sql.begin((tx) => recordConfirmedErrorTx(tx, failure));
    expect(first).not.toBeNull();
    if (!first) throw new Error("Expected confirmed error delivery");
    const replay = await stack.sql.begin((tx) => recordConfirmedErrorTx(tx, { ...failure, message: "후속 문구" }));
    expect(replay?.delivery_id).toBe(first.delivery_id);
    expect(replay?.payload).toEqual(first.payload);
    expect(first.target_session_id).toBe("caller-session");
    expect(first.payload.text).toContain("launch");
    expect(first.payload.text).toContain("노드가 명시적으로 거부했습니다");
    expect(await h.sql`SELECT delivery_id FROM session_deliveries WHERE relation_key=${first.relation_key}`).toHaveLength(1);

    const proof = { registrationId: "registration-exact", executionCommandId: "command-exact" };
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,folder_id,model_preset)
      VALUES (${receipt.work.sessionId},'node-a','agent-a','initializing',${receipt.card.id},'work','model-a')`;
    await h.sql`UPDATE card_execution_requests SET execution=${h.sql.json(proof)} WHERE id=${receipt.work.requestId}`;
    const eventId = await recordWorkReceipt(h, receipt.work.sessionId, "error", proof, "error_aborted");
    const canonical = {
      sessionId: receipt.work.sessionId,
      eventId,
      executionCommandId: proof.executionCommandId,
      registrationId: proof.registrationId,
      applied: true,
      status: "error",
      terminationReason: "error_aborted",
      message: "실행이 종료됐습니다",
    };
    const runtime = await stack.sql.begin((tx) => relayCanonicalErrorTx(tx, canonical));
    expect(runtime).not.toBeNull();
    expect(runtime?.delivery_id).toBe(canonicalWorkErrorDeliveryId(receipt.work.sessionId, eventId));
    expect(runtime?.relation_key).toBe(`dispatch-work-error:runtime:${receipt.work.sessionId}:${eventId}`);
    expect(runtime?.target_session_id).toBe("caller-session");
    expect(runtime?.payload.text).toContain("runtime");
    expect(runtime?.payload.text).toContain("실행이 종료됐습니다");

    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,folder_id,model_preset)
      VALUES ('unrelated-fatal','node-a','agent-a','initializing','work','model-a')`;
    const unrelatedProof = { registrationId: "registration-other", executionCommandId: "command-other" };
    const unrelatedEvent = await recordWorkReceipt(h, "unrelated-fatal", "error", unrelatedProof, "error_aborted");
    const unrelated = await stack.sql.begin((tx) => relayCanonicalErrorTx(tx, {
      ...canonical,
      sessionId: "unrelated-fatal",
      eventId: unrelatedEvent,
      executionCommandId: unrelatedProof.executionCommandId,
      registrationId: unrelatedProof.registrationId,
    }));
    expect(unrelated).toBeNull();
  }, 60000);
});

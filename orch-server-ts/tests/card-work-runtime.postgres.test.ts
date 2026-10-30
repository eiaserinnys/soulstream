import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCardDispatchRuntime } from "../src/cards/card_dispatch_runtime.js";
import { canonicalWorkErrorDeliveryId } from "../src/cards/card_work_error_delivery.js";
import type { DispatchWorkActor } from "../src/cards/card_work_dispatch_service.js";
import { EventIngressRepository, LiveEventIngressSqlProvider } from "../src/node/event_ingress_repository.js";
import type { EventAppendBatch, EventSessionEffect } from "../src/node/event_ingress_types.js";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../src/mcp/types.js";
import {
  createCardWorkErrorIngressCommitter,
  createCardWorkErrorSessionEffectApplier,
} from "../src/production.js";
import { prepareCardWorkSchema, recordWorkReceipt } from "./card-work-postgres-fixture.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

const CALLER_ID = "dispatch-runtime-caller";
const ACTOR: DispatchWorkActor = { actorKind: "agent", actorSessionId: CALLER_ID };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function structuredContent(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null || !("structuredContent" in result))
    throw new Error("MCP result has no structured content");
  const value = result.structuredContent;
  if (typeof value !== "object" || value === null) throw new Error("MCP structured content is not an object");
  return value as Record<string, unknown>;
}

describe("card work runtime and internal MCP integration", () => {
  let h: PagePostgresHarness;
  let runtime: Awaited<ReturnType<typeof createCardDispatchRuntime>>;
  let mcp: McpHostOptions;
  let createCommandCount = 0;
  let lastCreatePayload: Record<string,unknown> | null = null;
  let interventionCommandCount = 0;
  let rejectNextCreate = false;
  let holdNextCreate = false;
  let heldCreate: ReturnType<typeof deferred> | null = null;
  let createStarted = deferred();
  let createReturned = deferred();
  let errorDeliveryAccepted: (() => void) | undefined;
  let acceptedDelivery: (() => void) | undefined;
  let rejectDeliveryTarget: string | null = null;
  const warn = vi.fn();

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/088_claude_background_task_generations.sql", import.meta.url), "utf8"));
    await h.sql`ALTER TABLE sessions ADD COLUMN termination_detail TEXT,
      ADD COLUMN last_assistant_text TEXT, ADD COLUMN worktree_id TEXT`;
    const canonicalSchema = await readFile(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8");
    for (const functionName of ["session_record_execution_registration", "session_apply_terminal_transition"]) {
      const startMarker = `CREATE OR REPLACE FUNCTION ${functionName}(`;
      const start = canonicalSchema.indexOf(startMarker);
      const endMarker = "\n$$;";
      const end = canonicalSchema.indexOf(endMarker, start);
      if (start < 0 || end < 0) throw new Error(`Canonical schema is missing ${functionName}`);
      await h.sql.unsafe(canonicalSchema.slice(start, end + endMarker.length));
    }
    await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/116_card_execution_requests.sql", import.meta.url), "utf8"));
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
    await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/113_card_orchestration.sql", import.meta.url), "utf8"));
    await h.sql`INSERT INTO folders(id,name) VALUES ('work','작업')`;
    await h.sql`INSERT INTO system_settings(setting_key,value,updated_by) VALUES ('card_dispatch','{"nodeConcurrency":{"default":2}}','test')`;
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,folder_id,model_preset)
      VALUES (${CALLER_ID},'node-a','agent-a','running','work','model-a')`;

    const router = {
      isNodeConnected: () => true,
      selectNodeForCreate: ({ nodeId, profileId, modelPresetId }: { nodeId: string; profileId: string; modelPresetId?: string }) => ({
        nodeId, profileId, modelPresetId: modelPresetId ?? "model-a",
      }),
      createSession: (payload: Record<string, unknown>) => {
        lastCreatePayload = payload;
        createCommandCount += 1;
        return {
          node: { nodeId: String(payload.nodeId) },
          modelPresetId: String(payload.model_preset ?? "model-a"),
          command: { commandType: "create_session", requestId: `create-${createCommandCount}`, message: payload },
        };
      },
      routeExistingSessionPendingCommand: (payload: Record<string, unknown>) => ({
        node: { nodeId: "node-a" },
        command: { commandType: String(payload.type), requestId: `command-${randomUUID()}`, message: payload },
      }),
      waitForCreatedSession: async () => false,
    };
    const bridge = {
      sendPendingCommand: async (routed: { command: { commandType: string; message: Record<string, unknown> } }) => {
        const payload = routed.command.message;
        if (routed.command.commandType === "create_session") {
          createStarted.resolve();
          if (holdNextCreate) {
            holdNextCreate = false;
            heldCreate = deferred();
            await heldCreate.promise;
          }
          if (rejectNextCreate) {
            rejectNextCreate = false;
            createReturned.resolve();
            return { type: "error", status: "error", code: "CREATE_DENIED", message: "node rejected create" };
          }
          await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,folder_id,model_preset)
            VALUES (${String(payload.agentSessionId)},'node-a',${String(payload.profile)},'initializing',${String(payload.cardId)},${String(payload.folderId)},'model-a')
            ON CONFLICT(session_id) DO NOTHING`;
          createReturned.resolve();
          return { type: "session_created", status: "ok", agentSessionId: payload.agentSessionId };
        }
        if (routed.command.commandType === "intervene") {
          interventionCommandCount += 1;
          const row = (await h.sql<Array<{
            producer_kind: string | null;
            target_session_id: string | null;
          }>>`SELECT producer_kind,target_session_id FROM session_deliveries WHERE delivery_id=${String(payload.delivery_id)}`)[0];
          if (row?.producer_kind !== "card_work_error" && row?.target_session_id === rejectDeliveryTarget) {
            rejectDeliveryTarget = null;
            return { type: "error", status: "error", code: "DELIVERY_DENIED", message: "node rejected delivery" };
          }
          await h.sql`UPDATE session_deliveries SET state='queued',queued_at=NOW(),updated_at=NOW()
            WHERE delivery_id=${String(payload.delivery_id)}`;
          if (row?.producer_kind === "card_work_error") errorDeliveryAccepted?.();
          else acceptedDelivery?.();
          return { type: "intervene_ack", status: "ok", outcome: "queued" };
        }
        return { type: "ack", status: "ok" };
      },
    };
    runtime = await createCardDispatchRuntime({
      sqlResolver: { resolveSql: async () => h.liveSql, close: async () => undefined },
      router: router as never,
      bridge: bridge as never,
      availability: { resolveForNode: () => ({ available: true }), requireAvailable: () => undefined } as never,
      notifier: {} as never,
      admin: {} as never,
      broadcaster: { append: () => undefined } as never,
      warn,
      onFolderHeaderUpdated: async () => undefined,
      usageSnapshot: () => ({}) as never,
      ensureSystemFolder: async () => undefined,
      validateFolder: async () => true,
      resolveSessionOwner: async () => null,
      findUserByEmail: async () => null,
    });
    mcp = {
      authBearerToken: "test",
      cards: {
        cardServiceProvider: runtime.serviceProvider,
        provider: { listFolders: async () => [{ id: "work", name: "작업" }] },
        resolveAccess: async () => ({ restricted: false, allowedFolderIds: [] }),
        workDispatchServiceProvider: runtime.workDispatchServiceProvider,
      },
    } as unknown as McpHostOptions;
  }, 60000);

  afterAll(async () => {
    await runtime?.dispatcher.drain();
    await h?.cleanup();
  });

  it("sends the replacement handoff prompt and reports a confirmed launch failure to PAS",async()=>{
    const cards=await runtime.serviceProvider();
    const made=await cards.createCard({actorKind:"user",actorSessionId:null,actorUserId:"test",folderId:"work",
      title:"이어받을 카드",request:"원래 요청",assignee:{kind:"agent",agentId:"agent-a"},nodeId:"node-a",modelPreset:"model-a"});
    const cardId=made.operation.target_id,owner=`prompt-owner-${cardId}`,child=`prompt-child-${cardId}`;
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,folder_id,model_preset,caller_session_id)
      VALUES(${owner},'node-a','agent-a','error',${cardId},'work','model-a',NULL),
      (${child},'node-a','worker','running',${cardId},'work','model-a',${owner})`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_agent_id=NULL,assignee_session_id=${owner} WHERE id=${cardId}`;
    const delivered=deferred(); errorDeliveryAccepted=delivered.resolve; rejectNextCreate=true;
    const result=await executeMcpTool(mcp,"dispatch_work",{card_id:cardId,replace_assignee:true,
      request:"교체 요청 원문",brief:"새 완료 기준",idempotency_key:`prompt-${cardId}`},
      {principal:"internal",callerSessionId:CALLER_ID,nodeId:"node-a"});
    expect(structuredContent(result)).toMatchObject({accepted:true,request_id:expect.any(String)});
    await delivered.promise;
    const prompt=String((lastCreatePayload as Record<string,unknown> | null)?.prompt);
    for(const fragment of ["[카드 담당 교체]","이어받을 카드",owner,child,"교체 요청 원문","새 완료 기준",
      "get_session_summary","list_session_events"]) expect(prompt).toContain(fragment);
    const requestId=String(structuredContent(result).request_id);
    expect(await h.sql`SELECT state FROM card_execution_requests WHERE id=${requestId}`).toEqual([{state:"failed"}]);
    expect((await h.sql`SELECT assignee_session_id FROM cards WHERE id=${cardId}`)[0]!.assignee_session_id).toBe(owner);
    const failure=(await h.sql`SELECT target_session_id,payload FROM session_deliveries
      WHERE producer_kind='card_work_error' AND payload->>'text' LIKE ${`%${requestId}%`}`)[0]!;
    expect(failure.target_session_id).toBe(CALLER_ID);
  },60000);

  it("returns a committed MCP receipt before kick, keeps normal acceptance quiet, and routes only confirmed errors", async () => {
    const context = { principal: "internal" as const, callerSessionId: CALLER_ID, nodeId: "node-a" };
    createStarted = deferred();
    createReturned = deferred();
    holdNextCreate = true;
    const accepted = await executeMcpTool(mcp, "dispatch_work", {
      title: "정상 접수",
      request: "원문 요청",
      brief: "완료 기준",
      idempotency_key: "runtime-receipt",
    }, context);
    const acceptedContent = structuredContent(accepted);
    expect(acceptedContent).toMatchObject({ accepted: true, idempotent: false, card: { id: expect.any(String) }, request_id: expect.any(String) });
    await createStarted.promise;
    const stored = await h.sql<Array<{ request: string; state: string; session_id: string }>>`
      SELECT c.request,r.state,r.session_id FROM cards c JOIN card_execution_requests r ON r.card_id=c.id
      WHERE r.id=${String(acceptedContent.request_id)}`;
    expect(stored).toEqual([{ request: "원문 요청", state: "pending", session_id: expect.any(String) }]);
    expect(await h.sql`SELECT delivery_id FROM session_deliveries WHERE producer_kind='card_work_error' AND producer_id=(
      SELECT id FROM folder_operations WHERE idempotency_key=${`dispatch-work:${CALLER_ID}:runtime-receipt`})`).toHaveLength(0);
    heldCreate!.resolve();
    await createReturned.promise;
    await tick();
    expect(await h.sql`SELECT delivery_id FROM session_deliveries WHERE producer_kind='card_work_error' AND producer_id=(
      SELECT id FROM folder_operations WHERE idempotency_key=${`dispatch-work:${CALLER_ID}:runtime-receipt`})`).toHaveLength(0);

    createStarted = deferred();
    createReturned = deferred();
    const launchErrorAccepted = deferred();
    errorDeliveryAccepted = launchErrorAccepted.resolve;
    rejectNextCreate = true;
    const rejectedLaunch = await executeMcpTool(mcp, "dispatch_work", {
      title: "명시적 시작 거절",
      request: "원문 요청",
      idempotency_key: "runtime-create-ack-error",
    }, context);
    expect(structuredContent(rejectedLaunch)).toMatchObject({ accepted: true, card: { id: expect.any(String) }, request_id: expect.any(String) });
    await launchErrorAccepted.promise;
    const launchErrorRows = await h.sql<Array<{ target_session_id: string | null; payload: { text?: string }; state: string }>>`
      SELECT target_session_id,payload,state FROM session_deliveries
      WHERE producer_kind='card_work_error' AND payload->>'text' LIKE '%단계: launch%'
        AND producer_id=(SELECT id FROM folder_operations WHERE idempotency_key=${`dispatch-work:${CALLER_ID}:runtime-create-ack-error`})`;
    expect(launchErrorRows).toHaveLength(1);
    expect(launchErrorRows[0]).toMatchObject({ target_session_id: CALLER_ID, state: "queued" });
    expect(launchErrorRows[0]!.payload.text).toContain("node rejected create");

    const cards = await runtime.serviceProvider();
    const followupCard = await cards.createCard({
      actorKind: "user", actorSessionId: null, actorUserId: "test-user", folderId: "work",
      title: "정상 후속", request: "기존 요청", assignee: { kind: "agent", agentId: "agent-a" },
      nodeId: "node-a", modelPreset: "model-a", idempotencyKey: "runtime-followup-card",
    });
    const ownerId = "runtime-followup-owner";
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,folder_id,model_preset)
      VALUES (${ownerId},'node-a','agent-a','running',${followupCard.operation.target_id},'work','model-a')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_agent_id=NULL,assignee_session_id=${ownerId}
      WHERE id=${followupCard.operation.target_id}`;
    const normalFollowupAccepted = deferred();
    acceptedDelivery = normalFollowupAccepted.resolve;
    const normalFollowup = await executeMcpTool(mcp, "dispatch_work", {
      card_id: followupCard.operation.target_id,
      request: "후속 지시",
      idempotency_key: "runtime-followup-ok",
    }, context);
    expect(structuredContent(normalFollowup)).toMatchObject({ accepted: true, card: { id: followupCard.operation.target_id }, delivery_id: expect.any(String) });
    await normalFollowupAccepted.promise;
    expect(await h.sql`SELECT delivery_id FROM session_deliveries WHERE producer_kind='card_work_error' AND producer_id=(
      SELECT id FROM folder_operations WHERE idempotency_key=${`dispatch-work:${CALLER_ID}:runtime-followup-ok`})`).toHaveLength(0);

    const failedFollowupCard = await cards.createCard({
      actorKind: "user", actorSessionId: null, actorUserId: "test-user", folderId: "work",
      title: "거절되는 후속", request: "기존 요청", assignee: { kind: "agent", agentId: "agent-a" },
      nodeId: "node-a", modelPreset: "model-a", idempotencyKey: "runtime-followup-failed-card",
    });
    const failedOwnerId = "runtime-followup-failed-owner";
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,folder_id,model_preset)
      VALUES (${failedOwnerId},'node-a','agent-a','running',${failedFollowupCard.operation.target_id},'work','model-a')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_agent_id=NULL,assignee_session_id=${failedOwnerId}
      WHERE id=${failedFollowupCard.operation.target_id}`;
    const followupErrorAccepted = deferred();
    errorDeliveryAccepted = followupErrorAccepted.resolve;
    rejectDeliveryTarget = failedOwnerId;
    const failedFollowup = await executeMcpTool(mcp, "dispatch_work", {
      card_id: failedFollowupCard.operation.target_id,
      request: "거절될 후속 지시",
      idempotency_key: "runtime-followup-ack-error",
    }, context);
    expect(structuredContent(failedFollowup)).toMatchObject({ accepted: true, card: { id: failedFollowupCard.operation.target_id }, delivery_id: expect.any(String) });
    await followupErrorAccepted.promise;
    const deliveryErrorRows = await h.sql<Array<{ target_session_id: string | null; payload: { text?: string }; state: string }>>`
      SELECT target_session_id,payload,state FROM session_deliveries
      WHERE producer_kind='card_work_error' AND payload->>'text' LIKE '%단계: delivery%'`;
    expect(deliveryErrorRows).toHaveLength(1);
    expect(deliveryErrorRows[0]).toMatchObject({ target_session_id: CALLER_ID, state: "queued" });
    expect(deliveryErrorRows[0]!.payload.text).toContain("node rejected delivery");

    const dispatchService = await runtime.workDispatchServiceProvider(async () => undefined);
    const pending = await dispatchService.accept({
      kind: "create", title: "hook 대기", request: "hook 원문", idempotencyKey: "runtime-hook-pending", nodeId: "node-hook",
    }, ACTOR);
    if (pending.work.kind !== "execution") throw new Error("Expected execution reservation");
    const createsBeforeHook = createCommandCount;
    await runtime.kickPendingWorkForNode("node-hook");
    expect(createCommandCount).toBe(createsBeforeHook + 1);
    expect(await h.sql`SELECT state FROM card_execution_requests WHERE id=${pending.work.requestId}`).toEqual([{ state: "pending" }]);

    const canonical = await dispatchService.accept({
      kind: "create", title: "canonical 오류", request: "canonical 원문", idempotencyKey: "runtime-canonical-error", nodeId: "node-canonical",
    }, ACTOR);
    if (canonical.work.kind !== "execution") throw new Error("Expected execution reservation");
    await runtime.kickPendingWorkForNode("node-canonical");
    const commandProof = { registrationId: "runtime-registration", executionCommandId: "runtime-command" };
    await h.sql`UPDATE sessions SET status='initializing' WHERE session_id=${canonical.work.sessionId}`;
    const eventRepository = new EventIngressRepository(
      new LiveEventIngressSqlProvider({ resolveSql: async () => h.liveSql, close: async () => undefined }),
      createCardWorkErrorSessionEffectApplier(),
    );
    const relationlessId = "runtime-unrelated-fatal";
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,folder_id)
      VALUES (${relationlessId},'node-a','agent-a','running','work')`;
    const relationlessKick = deferred();
    const committer = createCardWorkErrorIngressCommitter(eventRepository, async (sessionId, eventId) => {
      await runtime.kickCanonicalWorkError(sessionId, eventId);
      if (sessionId === relationlessId) relationlessKick.resolve();
    });
    const registrationResult = await committer.commitBatch("node-canonical", eventBatch(canonical.work.sessionId, {
      kind: "execution_registration", registration_id: commandProof.registrationId,
      execution_command_id: commandProof.executionCommandId, review_state: "not_required",
      updated_at: new Date().toISOString(),
    }));
    expect(registrationResult[0]).toMatchObject({ outcome: "committed", sessionEffectApplication: { applied: true } });
    const runtimeErrorAccepted = deferred();
    errorDeliveryAccepted = runtimeErrorAccepted.resolve;
    const terminalResult = await committer.commitBatch("node-canonical", eventBatch(canonical.work.sessionId, {
      kind: "terminal_transition", status: "error", termination_reason: "error_aborted",
      termination_detail: "canonical runner error", review_state: "not_required", updated_at: new Date().toISOString(),
    }, commandProof.registrationId));
    expect(terminalResult[0]).toMatchObject({ outcome: "committed", sessionEffectApplication: { applied: true, canonicalSession: { status: "error", termination_reason: "error_aborted" } } });
    await runtimeErrorAccepted.promise;
    if (terminalResult[0]?.outcome !== "committed") throw new Error("Expected committed terminal event");
    const canonicalRows = await h.sql<Array<{ target_session_id: string | null; payload: { text?: string }; state: string }>>`
      SELECT target_session_id,payload,state FROM session_deliveries
      WHERE delivery_id=${canonicalWorkErrorDeliveryId(canonical.work.sessionId, terminalResult[0].eventId)}`;
    expect(canonicalRows).toHaveLength(1);
    expect(canonicalRows[0]).toMatchObject({ target_session_id: CALLER_ID, state: "queued" });
    expect(canonicalRows[0]!.payload.text).toContain("canonical runner error");

    const callsBeforeUnrelated = interventionCommandCount;
    const unrelatedResult = await committer.commitBatch("node-a", eventBatch(relationlessId, {
      kind: "terminal_transition", status: "error", termination_reason: "error_aborted",
      termination_detail: "unrelated fatal", review_state: "not_required", updated_at: new Date().toISOString(),
    }));
    expect(unrelatedResult[0]).toMatchObject({ outcome: "committed", sessionEffectApplication: { applied: true } });
    await relationlessKick.promise;
    expect(interventionCommandCount).toBe(callsBeforeUnrelated);
    expect(await h.sql`SELECT delivery_id FROM session_deliveries WHERE producer_kind='card_work_error'
      AND payload->>'text' LIKE '%unrelated fatal%'`).toHaveLength(0);
  }, 60000);

  it("a node kick confirms a person's receipt-backed pending request without relaunching", async () => {
    const cards = await runtime.serviceProvider();
    const card = await cards.createCard({
      actorKind: "user", actorSessionId: null, actorUserId: "scan-user", folderId: "work",
      title: "사람 실행", request: "원문", assignee: { kind: "agent", agentId: "agent-a" },
      nodeId: "node-scan", modelPreset: "model-a", idempotencyKey: "runtime-scan-card",
    });
    const cardId = card.operation.target_id;
    const current = (await cards.getCard(cardId))!.card;
    const execution = await runtime.executionServiceProvider();
    const proof = { registrationId: `reg-${cardId}`, executionCommandId: `cmd-${cardId}` };
    const started = await execution.execute({
      actorKind: "user", actorSessionId: null, actorUserId: "scan-user", cardId,
      expectedVersion: current.version, idempotencyKey: "runtime-scan",
    });
    expect(started.execution.state).toBe("pending");
    const launchesBefore = createCommandCount;
    await recordWorkReceipt(h, started.execution.sessionId, "running", proof);
    await runtime.kickPendingWorkForNode("node-scan");
    expect(await h.sql`SELECT state,execution FROM card_execution_requests WHERE id=${started.execution.requestId}`)
      .toEqual([{ state: "succeeded", execution: proof }]);
    expect(createCommandCount).toBe(launchesBefore);
  }, 60000);

  it("a node kick confirms a sessionless automatic observe-mode request from its dispatch evidence", async () => {
    const cards = await runtime.serviceProvider();
    const execution = await runtime.executionServiceProvider();
    const card = await cards.createCard({
      actorKind: "user", actorSessionId: null, actorUserId: "auto-user", folderId: "work",
      title: "자동 배정", request: "원문", assignee: { kind: "agent", agentId: "agent-a" },
      nodeId: "node-auto", modelPreset: "model-a", idempotencyKey: "runtime-auto-card",
    });
    const cardId = card.operation.target_id;
    const runId = `run-${cardId}`;
    const sessionId = `automatic-${cardId}`;
    const proof = { registrationId: `auto-reg-${cardId}`, executionCommandId: `auto-cmd-${cardId}` };
    await h.sql`UPDATE cards SET status='queued' WHERE id=${cardId}`;
    await h.sql`INSERT INTO card_orchestration_runs(id,policy_version,input_hash,snapshot,target,session_id,execution_token,lease_token,lease_expires_at,state)
      VALUES(${runId},1,'hash','{}','{}',${sessionId},'execution-token','lease-token',NOW()+INTERVAL '1 hour','completed')`;
    await h.sql`INSERT INTO card_orchestration_dispatches(run_id,card_id,session_id,node_id,input,launch_token,state)
      VALUES(${runId},${cardId},${sessionId},'node-auto','{}','worker-token','launching')`;
    const current = (await cards.getCard(cardId))!.card;
    const started = await execution.execute({
      actorKind: "user", actorSessionId: null, actorUserId: "auto-user", cardId,
      expectedVersion: current.version, idempotencyKey: "runtime-auto",
    });
    expect(started.execution.state).toBe("pending");
    const reserved = (await h.sql<Array<{ mode: string; target: Record<string, unknown> }>>`
      SELECT mode,target FROM card_execution_requests WHERE id=${started.execution.requestId}`)[0]!;
    expect(reserved.mode).toBe("observe");
    expect(reserved.target).toEqual({ folderId: "work" });

    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,folder_id,model_preset)
      VALUES(${sessionId},'node-auto','agent-a','running',${cardId},'work','model-a')`;
    await h.sql`UPDATE card_orchestration_dispatches SET state='running',input=${h.sql.json({ execution: proof })} WHERE session_id=${sessionId}`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_session_id=${sessionId},assignee_agent_id=NULL,status='review' WHERE id=${cardId}`;

    const launchesBefore = createCommandCount;
    await runtime.kickPendingWorkForNode("node-auto");
    expect(await h.sql`SELECT state,execution FROM card_execution_requests WHERE id=${started.execution.requestId}`)
      .toEqual([{ state: "succeeded", execution: proof }]);
    expect(createCommandCount).toBe(launchesBefore);
    expect((await cards.getCard(cardId))!.card.status).toBe("review");
  }, 60000);

  async function tick() {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
});

function eventBatch(sessionId: string, effect: EventSessionEffect, registrationId?: string): EventAppendBatch {
  const streamId = randomUUID();
  const payload = { type: "session_updated" };
  return {
    type: "event_append_batch",
    protocol_version: 1,
    stream_id: streamId,
    first_seq: 1,
    events: [{
      stream_id: streamId,
      source_seq: 1,
      session_id: sessionId,
      ...(registrationId ? { registration_id: registrationId } : {}),
      event_type: "session_updated",
      payload,
      searchable_text: null,
      created_at: new Date().toISOString(),
      semantic_dedupe_key: null,
      session_effect: effect,
      payload_hash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    }],
  };
}

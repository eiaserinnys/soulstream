import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page/page_postgres_harness.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardOrchestrationRepository,type OrchestrationRun } from "../src/cards/card_orchestration_repository.js";
import { CardOrchestrationCoordinator } from "../src/cards/card_orchestration_coordinator.js";
import {
  readCardOrchestrationSettings,
  updateCardOrchestrationSettings,
} from "../src/cards/card_orchestration_settings.js";
import type { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import {hasContinuousLimitWindow} from "../src/schedule/resume_after_limit_continuity.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { appendCardEventTx, prepareCardWorkSchema, recordWorkReceipt, consumeCardDelivery } from "./card-work-postgres-fixture.js";
// Existing disposable harness; no DATABASE_URL or production schema is used.
describe("durable card orchestration admissions", () => {
  let h: PagePostgresHarness,
    repo: CardOrchestrationRepository,
    cards: CardControlPlaneService,
    settingsSql: ReturnType<typeof createBoardYjsSqlAdapter>;
  const target = {
    agentId: "ariella-orchestrator",
    nodeId: "eiaserinnys",
    modelPreset: "claude-opus",
    minimumRemainingPercent: 15,
  };
  const actor = {
    actorKind: "user" as const,
    actorSessionId: null,
    actorUserId: "director@example.com",
  };
  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version BIGINT NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
    await h.sql`INSERT INTO system_settings VALUES('card_dispatch','{"nodeConcurrency":{"default":1}}',1,NOW(),'migration')`;
    await h.sql.unsafe(
      await readFile(
        new URL(
          "../../packages/db-schema/sql/migrations/113_card_orchestration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await h.sql`INSERT INTO folders(id,name) VALUES('orchestration-folder','실험')`;
    await h.sql`CREATE TABLE soulstream_schedules(schedule_id TEXT PRIMARY KEY,session_id TEXT,source_tool TEXT,tool_use_id TEXT,status TEXT)`;
    const sql = createBoardYjsSqlAdapter(h.liveSql);
    settingsSql = sql;
    repo = new CardOrchestrationRepository(async () => sql);
    cards = new CardControlPlaneService(sql, { appendEventTx: appendCardEventTx });
  }, 60000);
  afterAll(async () => h?.cleanup());
  beforeEach(async () => {
    await h.sql`DELETE FROM card_orchestration_dispatches`;
    await h.sql`DELETE FROM card_orchestration_runs`;
    await h.sql`UPDATE card_orchestration_state SET last_decision_input_hash=NULL,provision_id=NULL,provision_request=NULL,resolved_folder_id=NULL`;
    await h.sql`DELETE FROM folder_operations`;
    await h.sql`DELETE FROM card_questions`;
    await h.sql`DELETE FROM card_reports`;
    await h.sql`DELETE FROM cards`;
    await h.sql`UPDATE system_settings SET value='{"enabled":true,"candidates":[],"usageMaxAgeMs":300000,"sessionFolderId":null,"systemFolderParentId":null}',version=1 WHERE setting_key='card_orchestration'`;
  });
  async function make() {
    return (
      await cards.createCard({
        ...actor,
        folderId: "orchestration-folder",
        title: "작업",
        request: "실행",
        queue: true,
        assignee: { kind: "agent", agentId: "roselin" },
      })
    ).operation.target_id;
  }
  async function run(ids: string[]) {
    const snapshot = await Promise.all(
      ids.map(async (id) => ({
        cardId: id,
        cardVersion: (await cards.getCard(id))!.card.version,
      })),
    );
    const r = (await repo.claim({
      inputHash: "logical",
      policyVersion: 1,
      snapshot,
      target,
    }))!;
    await repo.prepareLaunch(r);
    await repo.decide(
      r,
      {
        decisions: snapshot.map((c) => ({
          ...c,
          action: "run" as const,
          reason: "준비됨",
        })),
      },
      1,
      "instructions-sha",
    );
    return { ...r, state: "decided" as const };
  }
  function admission(r: OrchestrationRun, id: string):import("../src/cards/card_control_plane_service.js").PolicyAdmission {
    return {
      runId: r.id,
      leaseToken: r.lease_token,
      workerInput: {
        agentId: "roselin",
        modelPreset: "worker-model",
        configuredModelPreset: null,
        folderId: "orchestration-folder",
        cardId: id,
        nodeId: "eiaserinnys",
      },
    };
  }
  function coordinator() {
    const launchDecision = vi.fn(async () => undefined);
    const ensureFolder = vi.fn(async () => "orchestration-folder");
    const warn = vi.fn();
    return {
      launchDecision,
      ensureFolder,
      warn,
      value: new CardOrchestrationCoordinator({
        repository: repo,
        cards: async () => cards,
        dispatch: {} as CardDispatchRepository,
        settings: async () => readCardOrchestrationSettings(settingsSql),
        resolveTarget: () => ({ ...target, available: true, reason: null }),
        selectOrchestrator: async () => ({
          candidate: target,
          reason: null,
        }),
        ensureFolder,
        launchDecision,
        launchWorker: async () => undefined,
        sendMessage: async () => undefined,
        warn,
      }),
    };
  }
  it("normalizes real PostgreSQL BIGINT versions and launches the same policy version", async () => {
    const rawBefore = await h.sql`SELECT version FROM system_settings WHERE setting_key='card_orchestration'`;
    expect(rawBefore[0]?.version).toBe("1");
    expect((await readCardOrchestrationSettings(settingsSql)).version).toBe(1);

    const saved = await updateCardOrchestrationSettings(settingsSql, {
      policy: { enabled: true, candidates: [target], usageMaxAgeMs: 300000, sessionFolderId: null, systemFolderParentId: null },
      expectedVersion: 1,
      updatedBy: "admin@example.com",
    });
    expect(saved.version).toBe(2);
    expect((await h.sql`SELECT version FROM system_settings WHERE setting_key='card_orchestration'`)[0]?.version).toBe("2");

    const run = (await repo.claim({ inputHash: "same-policy", policyVersion: saved.version, snapshot: [], target }))!;
    await h.sql`UPDATE card_orchestration_runs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=${run.id}`;
    const c = coordinator();
    await c.value.kick();
    expect(c.launchDecision).toHaveBeenCalledTimes(1);
    expect(c.ensureFolder).toHaveBeenCalledTimes(1);
    expect(c.warn).not.toHaveBeenCalled();
    expect((await h.sql`SELECT state,reason FROM card_orchestration_runs WHERE id=${run.id}`)[0]).toEqual({ state: "judging", reason: null });
  });
  it("keeps cancelling a run whose policy version is genuinely stale", async () => {
    const run = (await repo.claim({ inputHash: "stale-policy", policyVersion: 1, snapshot: [], target }))!;
    await updateCardOrchestrationSettings(settingsSql, {
      policy: { enabled: true, candidates: [target], usageMaxAgeMs: 300000, sessionFolderId: null, systemFolderParentId: null },
      expectedVersion: 1,
      updatedBy: "admin@example.com",
    });
    await h.sql`UPDATE card_orchestration_runs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=${run.id}`;
    const c = coordinator();
    await c.value.kick();
    expect(c.launchDecision).not.toHaveBeenCalled();
    expect(c.ensureFolder).not.toHaveBeenCalled();
    expect(c.warn).not.toHaveBeenCalled();
    expect((await h.sql`SELECT state,reason FROM card_orchestration_runs WHERE id=${run.id}`)[0]).toEqual({ state: "cancelled", reason: "policy_changed" });
  });
  it("admits an explicitly queued card despite an unanswered question",async()=>{
    const id=await make();
    await h.sql`INSERT INTO card_questions(id,card_id,text) VALUES('unanswered',${id},'판단')`;
    const r=await run([id]);
    await cards.recordDispatch({cardId:id,expectedVersion:1,sessionId:`worker-${id}`,nodeId:target.nodeId,admission:admission(r,id)});
    expect((await cards.getCard(id))?.card.status).toBe('queued');
    expect(await h.sql`SELECT * FROM card_orchestration_dispatches WHERE card_id=${id}`).toHaveLength(1);
  });
  it("claims once concurrently and recovers the same session with a fenced lease", async () => {
    const input = {
      inputHash: "logical",
      policyVersion: 1,
      snapshot: [],
      target,
    };
    const other = new CardOrchestrationRepository(async () =>
      createBoardYjsSqlAdapter(h.peerLiveSql),
    );
    const claims = await Promise.all([repo.claim(input), other.claim(input)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const initial = claims.find(Boolean)!;
    await h.sql`UPDATE card_orchestration_runs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=${initial.id}`;
    const recovered = (await other.claim(input))!;
    expect(recovered.session_id).toBe(initial.session_id);
    expect(recovered.execution_token).toBe(initial.execution_token);
    expect(recovered.lease_token).not.toBe(initial.lease_token);
    expect(await repo.prepareLaunch(initial)).toBe(false);
    expect(await other.prepareLaunch(recovered)).toBe(true);
    const auth = {
      runId: recovered.id,
      sessionId: recovered.session_id,
      executionToken: recovered.execution_token,
      nodeId: target.nodeId,
    };
    expect(await other.authorize(auth)).toBe(true);
    expect(await repo.authorize(auth)).toBe(false);
  });
  it("atomically admits only one of concurrent cards into one node slot", async () => {
    const ids = await Promise.all([make(), make()]),
      r = await run(ids);
    const results = await Promise.allSettled(
      ids.map(async (id) =>
        cards.recordDispatch({
          cardId: id,
          expectedVersion: 1,
          sessionId: `worker-${id}`,
          nodeId: target.nodeId,
          admission: admission(r, id),
        }),
      ),
    );
    expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    expect(
      await h.sql`SELECT * FROM card_orchestration_dispatches`,
    ).toHaveLength(1);
    expect(
      await h.sql`SELECT * FROM cards WHERE status='queued' AND assignee_kind='agent' AND assignee_session_id IS NULL AND version=2`,
    ).toHaveLength(1);
    expect(await h.sql`SELECT * FROM sessions WHERE session_id LIKE 'worker-%'`).toHaveLength(0);
  });
  it("rejects enabled FIFO bypass and stale card or policy versions", async () => {
    const id = await make(),
      r = await run([id]);
    await expect(
      cards.recordDispatch({
        cardId: id,
        expectedVersion: 1,
        sessionId: "bypass",
        nodeId: target.nodeId,
      }),
    ).rejects.toThrow("fenced");
    await cards.patchCard({
      ...actor,
      cardId: id,
      expectedVersion: 1,
      title: "바뀜",
    });
    await expect(
      cards.recordDispatch({
        cardId: id,
        expectedVersion: 1,
        sessionId: "stale-card",
        nodeId: target.nodeId,
        admission: admission(r, id),
      }),
    ).rejects.toThrow();
    await h.sql`UPDATE system_settings SET version=2 WHERE setting_key='card_orchestration'`;
    await expect(
      cards.recordDispatch({
        cardId: id,
        expectedVersion: 2,
        sessionId: "stale-policy",
        nodeId: target.nodeId,
        admission: admission(r, id),
      }),
    ).rejects.toThrow("Stale");
    expect(
      await h.sql`SELECT * FROM card_orchestration_dispatches`,
    ).toHaveLength(0);
  });
  it("persists completed input dedup and one lazy folder reservation across clients", async () => {
    const input = {
        inputHash: "defer",
        policyVersion: 1,
        snapshot: [],
        target,
      },
      r = (await repo.claim(input))!;
    await repo.finish(r, "completed", "all_deferred");
    const restarted = new CardOrchestrationRepository(async () =>
      createBoardYjsSqlAdapter(h.peerLiveSql),
    );
    expect(await restarted.claim(input)).toBeNull();
    expect(await restarted.isDuplicate("defer")).toBe(true);
    const reservations = await Promise.all([
      repo.reserveFolder(null),
      restarted.reserveFolder(null),
    ]);
    expect(reservations[0].provision_id).toBe(reservations[1].provision_id);
    expect(reservations[0].provision_id).toBeTruthy();
  });
  it("permits repeated limit resumes on the same session and ignores its old terminal row", async () => {
    const id = await make(),
      r = await run([id]),
      sid = "worker-resume";
    await cards.recordDispatch({
      cardId: id,
      expectedVersion: 1,
      sessionId: sid,
      nodeId: target.nodeId,
      admission: admission(r, id),
    });
    await repo.claimWorker(sid);
    const d = (await repo.pendingWorkers())[0]!;
    expect(
      await repo.authorizeWorker({
        runId: r.id,
        sessionId: sid,
        executionToken: d.launch_token,
        nodeId: target.nodeId,
        cardId: id,
      }),
    ).toBe(true);
    await h.sql`INSERT INTO sessions(session_id,card_id,node_id,agent_id,model_preset,status) VALUES(${sid},${id},${target.nodeId},'roselin','worker-model','running')`;
    const execution={registrationId:"first",executionCommandId:"first-command"};
    await recordWorkReceipt(h,sid,"running",execution);
    // A different live worker with the same profile/preset has no right to consume this admission.
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,model_preset,status) VALUES('wrong-worker',${target.nodeId},'roselin','worker-model','running')`;
    const wrong={registrationId:"wrong",executionCommandId:"wrong-command"};
    await recordWorkReceipt(h,"wrong-worker","running",wrong);
    await expect(cards.startCardWork({actorKind:"agent",actorSessionId:"wrong-worker",cardId:id,expectedVersion:2,idempotencyKey:"wrong-start",execution:wrong})).rejects.toThrow("assignee");
    expect((await cards.getCard(id))?.card).toMatchObject({status:"queued",assignee_kind:"agent",assignee_session_id:null,version:2});
    const start={actorKind:"agent" as const,actorSessionId:sid,cardId:id,expectedVersion:2,idempotencyKey:"first-start",execution};
    await cards.startCardWork(start);
    expect((await cards.startCardWork(start)).idempotent).toBe(true);
    expect((await cards.getCard(id))?.card).toMatchObject({status:"running",assignee_kind:"session",assignee_session_id:sid,version:3});
    await repo.finish(r, "completed", "applied");
    for (const terminal of [1, 2]) {
      const detail = (await cards.getCard(id))!;
      await cards.setCardStatus({
        ...actor,
        cardId: id,
        expectedVersion: detail.card.version,
        status: "blocked",
        blockedKind: "limit",
      });
      const version = (await cards.getCard(id))!.card.version;
      await expect(cards.resumeDispatchedCard({
        cardId: id, expectedVersion: version, sessionId: sid, nodeId: target.nodeId,
      })).rejects.toThrow("fenced");
      expect((await cards.getCard(id))!.card.status).toBe("blocked");
      const next = (await repo.claim({
        inputHash: `resume-${terminal}`,
        policyVersion: 1,
        snapshot: [{ cardId: id, cardVersion: version }],
        target,
      }))!;
      await repo.prepareLaunch(next);
      await repo.decide(
        next,
        {
          decisions: [
            {
              cardId: id,
              cardVersion: version,
              action: "run",
              reason: "fresh quota",
            },
          ],
        },
        terminal,
        "revision",
      );
      const marker = admission(next, id);
      marker.workerInput = {
        ...marker.workerInput,
        resume: true,
        existingSession:true,
        deliveryId:`resume-delivery-${terminal}`,
        priorTerminationEventId: terminal,
      };
      await cards.resumeDispatchedCard({
        cardId: id,
        expectedVersion: version,
        sessionId: sid,
        nodeId: target.nodeId,
        admission: marker,
      });
      await repo.claimWorker(sid);
      expect(await repo.workerObserved(sid)).toBe(false);
      await recordWorkReceipt(h,sid,"error",null,"limit_hit");
      expect(await repo.workerObserved(sid)).toBe(false);
      const current=(await repo.pendingWorkers())[0]!;
      expect(await repo.authorizeWorker({runId:next.id,sessionId:sid,executionToken:current.launch_token,nodeId:target.nodeId,cardId:id})).toBe(true);
      const execution={registrationId:`resume-${terminal}`,executionCommandId:`resume-command-${terminal}`};
      await recordWorkReceipt(h,sid,"running",execution);
      await consumeCardDelivery(h,`resume-delivery-${terminal}`,sid);
      await cards.startCardWork({actorKind:"agent",actorSessionId:sid,cardId:id,expectedVersion:version+1,idempotencyKey:`resume-start-${terminal}`,execution});
      expect(await repo.workerObserved(sid)).toBe(true);
      await repo.finish(next, "completed", "resumed");
    }
    expect(
      await h.sql`SELECT * FROM card_orchestration_dispatches WHERE session_id=${sid}`,
    ).toHaveLength(3);
  });
  it("fences a worker command that arrives after its launch deadline", async () => {
    const id = await make(),
      r = await run([id]),
      sid = "missed-worker";
    await cards.recordDispatch({
      cardId: id,
      expectedVersion: 1,
      sessionId: sid,
      nodeId: target.nodeId,
      admission: admission(r, id),
    });
    await repo.claimWorker(sid);
    const d = (await repo.pendingWorkers())[0]!;
    await h.sql`UPDATE card_orchestration_dispatches SET launch_deadline=NOW()-INTERVAL '1 second' WHERE session_id=${sid}`;
    expect(
      await repo.authorizeWorker({
        runId: r.id,
        sessionId: sid,
        executionToken: d.launch_token,
        nodeId: target.nodeId,
        cardId: id,
      }),
    ).toBe(false);
    expect((await repo.pendingWorkers())[0]).toMatchObject({
      expired: true,
      launch_accepted: false,
    });
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,model_preset,status) VALUES(${sid},${target.nodeId},'roselin','worker-model','running')`;
    const execution={registrationId:"expired-worker",executionCommandId:"expired-command"};
    await recordWorkReceipt(h,sid,"running",execution);
    await expect(cards.startCardWork({actorKind:"agent",actorSessionId:sid,cardId:id,expectedVersion:2,idempotencyKey:"expired-start",execution})).rejects.toThrow("admission");
    expect((await cards.getCard(id))?.card).toMatchObject({status:"queued",assignee_kind:"agent",assignee_session_id:null,version:2});
  });
  it("denies the existing reset-time automatic schedule only for policy-owned cards",async()=>{
    const id=await make(),sid='automatic-resume';
    await h.sql`INSERT INTO sessions(session_id,card_id,status,termination_event_id,termination_reason) VALUES(${sid},${id},'error',1,'limit_hit')`;
    await h.sql`INSERT INTO events(session_id,id,event_type,payload) VALUES(${sid},1,'session_ended','{"termination_reason":"limit_hit"}')`;
    const identity={scheduleId:`resume-after-limit:${sid}:1:0`,sessionId:sid,sourceTool:'ResumeAfterLimit',toolUseId:'ResumeAfterLimit:1'};
    await h.sql`INSERT INTO soulstream_schedules VALUES(${identity.scheduleId},${sid},${identity.sourceTool},${identity.toolUseId},'firing')`;
    const sql=createBoardYjsSqlAdapter(h.liveSql);
    expect(await hasContinuousLimitWindow(sql,identity,1)).toBe(false);
    await h.sql`UPDATE system_settings SET value=jsonb_set(value,'{enabled}','false') WHERE setting_key='card_orchestration'`;
    expect(await hasContinuousLimitWindow(sql,identity,1)).toBe(true);
    await h.sql`UPDATE system_settings SET value=jsonb_set(value,'{enabled}','true') WHERE setting_key='card_orchestration'`;
    await h.sql`UPDATE sessions SET card_id=NULL WHERE session_id=${sid}`;
    expect(await hasContinuousLimitWindow(sql,identity,1)).toBe(true);
  });

});

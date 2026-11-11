import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { prepareCardReminderSchema } from "./card-reminder-postgres-fixture.js";
import { appendCardEventTx, prepareCardWorkSchema, recordWorkReceipt } from "./card-work-postgres-fixture.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";
import { CardOrchestrationRepository } from "../src/cards/card_orchestration_repository.js";
import { CardOrchestrationCoordinator } from "../src/cards/card_orchestration_coordinator.js";
import { readCardOrchestrationSettings } from "../src/cards/card_orchestration_settings.js";
import { resolveCardSessionTarget } from "../src/cards/card_session_target.js";
import { selectNodeForSessionCreate } from "../src/session/session_create_node_selector.js";

// Disposable DB, real card mutations, session relations and canonical ingress receipts.
// Only worker transport, model availability and notifications are mocked.
describe("only the current assignee's quota termination blocks a card", () => {
  let h: PagePostgresHarness, cards: CardControlPlaneService, repo: CardDispatchRepository;
  let dispatcher: CardDispatcher, available = false;
  const human = { actorKind: "user" as const, actorSessionId: null };
  const execution = { registrationId: "owner-registration", executionCommandId: "owner-command" };
  const sendMessage = vi.fn(async () => {}), launch = vi.fn(async () => {}), warn = vi.fn();
  const target = () => ({ nodeId: "node", agentId: "worker", modelPreset: "model", available, reason: available ? null : "quota" });
  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await prepareCardReminderSchema(h);
    await h.sql`INSERT INTO folders(id,name) VALUES('limit-folder','한도')`;
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
    await h.sql`INSERT INTO system_settings(setting_key,value,updated_by) VALUES('card_dispatch','{"nodeConcurrency":{"default":2}}','test')`;
    await h.sql.unsafe(await readFile(new URL('../../packages/db-schema/sql/migrations/113_card_orchestration.sql', import.meta.url), 'utf8'));
    const sql = createFolderContentSqlAdapter(h.liveSql);
    cards = new CardControlPlaneService(sql, { appendEventTx: appendCardEventTx });
    repo = new CardDispatchRepository(async () => sql);
    dispatcher = new CardDispatcher({ repository: repo, cards: async () => cards, resolveTarget: target,
      launch, sendMessage, notify: async () => {}, deliveryExists: async () => false, abandonDelivery: async () => {}, warn });
  }, 60000);
  beforeEach(async () => {
    await dispatcher.drain();
    await h.sql`DELETE FROM card_orchestration_dispatches`;
    await h.sql`DELETE FROM card_orchestration_runs`;
    await h.sql`DELETE FROM folder_operations`;
    await h.sql`DELETE FROM cards`;
    await h.sql`DELETE FROM sessions`;
    await h.sql`UPDATE system_settings SET value=jsonb_set(value,'{enabled}','false') WHERE setting_key='card_orchestration'`;
    await h.sql`UPDATE system_settings SET value='{"nodeConcurrency":{"default":2}}' WHERE setting_key='card_dispatch'`;
    available = false;
    sendMessage.mockClear(); launch.mockClear(); warn.mockClear();
  });
  afterAll(async () => { await dispatcher?.drain(); await h?.cleanup(); });
  async function make(declared = false) {
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,model_preset,status) VALUES('owner','node','worker','model','running')`;
    await recordWorkReceipt(h, "owner", "running", execution);
    const id = (await cards.createCard({ ...human, folderId: "limit-folder", title: "요청", request: "실행",
      assignee: { kind: "session", sessionId: "owner" } })).operation.target_id;
    await h.sql`UPDATE sessions SET card_id=${id} WHERE session_id='owner'`;
    if (declared) await cards.startCardWork({ actorKind: "agent", actorSessionId: "owner", cardId: id, expectedVersion: 1, execution });
    else await cards.setCardStatus({ ...human, cardId: id, status: "running", expectedVersion: 1 });
    return id;
  }
  async function child(id: string) {
    await h.sql`INSERT INTO sessions(session_id,card_id,caller_session_id,node_id,agent_id,model_preset,status,created_at)
      VALUES('child',${id},'owner','node','worker','child-model','running',NOW()+INTERVAL '1 second')`;
  }
  async function ended(sessionId: string, reason: string | null) {
    await recordWorkReceipt(h, sessionId, reason ? "error" : "completed", null, reason);
    dispatcher.accept([{ type: "node_session_session_updated", nodeId: "node", committedIngress: true, data: { agentSessionId: sessionId } }]);
    await dispatcher.drain();
  }
  it.each([false, true])("preserves running owner when its newest child hits quota, declared=%s", async declared => {
    const id = await make(declared); await child(id);
    const before = (await cards.getCard(id))!.card;
    await ended("child", "limit_hit");
    expect((await cards.getCard(id))!.card).toMatchObject({ status: "running", blocked_kind: null, version: before.version });
    expect((await repo.session("child"))?.termination_reason).toBe("limit_hit");
    expect((await repo.session("owner"))?.status).toBe("running");
    expect(warn).not.toHaveBeenCalled();
  });
  it("preserves normal owner completion when a newer child hits quota", async () => {
    const id = await make(); await child(id); await ended("owner", null);
    const before = (await cards.getCard(id))!.card;
    await ended("child", "limit_hit");
    expect((await cards.getCard(id))!.card).toMatchObject({ status: "running", blocked_kind: null, version: before.version });
  });
  it.each([false, true])("blocks the limited owner even with a newer child, declared=%s", async declared => {
    const id = await make(declared); await child(id);
    await ended("owner", "limit_hit");
    expect((await cards.getCard(id))!.card).toMatchObject({ status: "blocked", blocked_kind: "limit", assignee_session_id: "owner" });
    expect(warn).not.toHaveBeenCalled();
  });
  it("ignores a former assignee's late quota termination", async () => {
    const id = await make();
    await h.sql`INSERT INTO sessions(session_id,card_id,node_id,agent_id,model_preset,status) VALUES('replacement',${id},'node','worker','model','running')`;
    await cards.patchCard({ ...human, cardId: id, assignee: { kind: "session", sessionId: "replacement" } });
    // Former owner is still newest: newest-session ordering is not ownership.
    await h.sql`UPDATE sessions SET created_at=NOW()+INTERVAL '1 second' WHERE session_id='owner'`;
    const before = (await cards.getCard(id))!.card;
    await ended("owner", "limit_hit");
    expect((await cards.getCard(id))!.card).toMatchObject({ status: "running", assignee_session_id: "replacement", version: before.version });
  });
  it("legacy recovery resumes the limited owner rather than the newest child", async () => {
    const id = await make(); await ended("owner", "limit_hit"); await child(id); await ended("child", "limit_hit");
    available = true;
    await dispatcher.checkLimits(); await dispatcher.drain();
    expect(sendMessage).not.toHaveBeenCalledWith("child", expect.anything());
    expect(sendMessage).toHaveBeenCalledWith("owner", expect.stringContaining("한도가 풀려"));
    expect((await cards.getCard(id))!.card.status).toBe("running");
    expect(launch).not.toHaveBeenCalled();
  });
  it("legacy recovery selects the recorded owner's node profile and model with the real selector",async()=>{
    const id=await make();await ended("owner","limit_hit");
    await cards.patchCard({...human,cardId:id,nodeId:"stale-card-node",modelPreset:"stale-card-model"});
    const node={nodeId:"node",agents:[{id:"worker",backend:"codex"}],supportedBackends:["codex"],modelPresets:[{id:"model",backend:"codex"}]};
    const registry={listConnectedNodesInRegistrationOrder:()=>[node],getConnectedNode:(id:string)=>id===node.nodeId?node:undefined} as unknown as Parameters<typeof selectNodeForSessionCreate>[0];
    const select=vi.fn((card:Parameters<NonNullable<ConstructorParameters<typeof CardDispatcher>[0]["resolveTarget"]>>[0],preset?:string|null)=>{
      try {
        const chosen=selectNodeForSessionCreate(registry,{nodeId:card.node_id!,profileId:card.assignee_agent_id!,modelPresetId:preset??card.model_preset??undefined});
        return {nodeId:chosen.node.nodeId,agentId:chosen.profileId,modelPreset:chosen.modelPresetId??null,available,reason:null};
      }catch(error){return {nodeId:card.node_id!,agentId:card.assignee_agent_id!,modelPreset:preset??null,available:false,reason:String(error)};}
    });
    const realSelectorDispatcher=new CardDispatcher({repository:repo,cards:async()=>cards,resolveTarget:select,
      launch,sendMessage,notify:async()=>{},deliveryExists:async()=>false,abandonDelivery:async()=>{},warn});
    available=false;
    await realSelectorDispatcher.checkLimits();await realSelectorDispatcher.drain();
    expect((await cards.getCard(id))!.card.status).toBe("blocked");
    available=true;
    await realSelectorDispatcher.checkLimits();await realSelectorDispatcher.drain();
    expect((await cards.getCard(id))!.card).toMatchObject({status:"running",limit_resume_session_id:null,limit_resume_at:null});
    expect(select).toHaveBeenLastCalledWith(expect.objectContaining({node_id:"node",assignee_agent_id:"worker"}),"model");
    expect(sendMessage).toHaveBeenCalledWith("owner",expect.stringContaining("한도가 풀려"));
    expect(launch).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
  it("coordinator recovery admits the limited owner rather than the newest child", async () => {
    const id = await make(); await ended("owner", "limit_hit"); await child(id); await ended("child", "limit_hit");
    await h.sql`UPDATE system_settings SET value=jsonb_set(value,'{enabled}','true') WHERE setting_key='card_orchestration'`;
    const orchestration = new CardOrchestrationRepository(async () => createFolderContentSqlAdapter(h.liveSql));
    const judge = { agentId: "judge", nodeId: "node", modelPreset: "judge-model", minimumRemainingPercent: 15 };
    const card = (await cards.getCard(id))!.card;
    const run = (await orchestration.claim({ inputHash: id, policyVersion: 1,
      snapshot: [{ cardId: id, cardVersion: card.version, folderName: "한도", card }], target: judge }))!;
    await orchestration.prepareLaunch(run);
    await orchestration.decide(run, { decisions: [{ cardId: id, cardVersion: card.version, action: "run", reason: "재개" }] }, 1, "revision");
    // Coordinator restart reclaims the durable decided run.
    await h.sql`UPDATE card_orchestration_runs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=${run.id}`;
    available = true;
    const coordinator = new CardOrchestrationCoordinator({ repository: orchestration, dispatch: repo, cards: async () => cards,
      settings: async () => readCardOrchestrationSettings(createFolderContentSqlAdapter(h.liveSql)), resolveTarget: target,
      resolveSessionTarget: async card => {
        const resolved = await resolveCardSessionTarget(card, id => repo.ownerSession(id), () => ({ available, reason: null }));
        return { nodeId: resolved.nodeId ?? "", agentId: resolved.agentId ?? "", modelPreset: resolved.modelPreset ?? null,
          sessionId: resolved.sessionId ?? undefined, available: resolved.available, reason: resolved.reason };
      },
      selectOrchestrator: async () => ({ candidate: judge, reason: null, instructionsRevision: "revision" }),
      ensureFolder: async () => "limit-folder", launchDecision: async () => {}, launchWorker: launch, sendMessage, warn });
    await coordinator.kick();
    const rows = await h.sql`SELECT session_id,input FROM card_orchestration_dispatches WHERE card_id=${id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: "owner", input: { resume: true, priorTerminationEventId: (await repo.session("owner"))!.termination_event_id } });
    expect(warn).not.toHaveBeenCalled();
  });
});

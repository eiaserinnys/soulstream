import { describe, expect, it, vi } from "vitest";
import type { OrchestrationDecision, OrchestrationSettings } from "../../packages/wire-schema/src/card_orchestration.js";
import { CardOrchestrationCoordinator, type CoordinatorOptions } from "../src/cards/card_orchestration_coordinator.js";
import type { CardOrchestrationRepository, OrchestrationRun, WorkerDispatch } from "../src/cards/card_orchestration_repository.js";
import type { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import type { CardDispatchRepository, DispatchCard } from "../src/cards/card_dispatch_repository.js";
import { ModelPresetAvailabilityService } from "../src/model/model_preset_availability.js";
import { strictOrchestrationUsage } from "../src/cards/orchestration_usage.js";
import type { NodeConnectionSnapshot } from "../src/node/registry_types.js";

function queuedCard(): DispatchCard {
  const now = new Date("2026-10-01T12:00:00Z");
  return { id: "queued-1", number: 1, color: "yellow", folder_id: "original-folder", folder_name: "작업 폴더", position_key: "a", queue_position_key: "a", title: "작업", request: "요청", attachments:[], items:[], now:null, brief: "", blocked_kind: null, blocked_detail: null, node_id: "node", model_preset: null, status: "queued", archived: false, version: 1, assignee_kind: "agent", assignee_agent_id: "worker", assignee_session_id: null, assignee_user_id: null, created_session_id: null, created_event_id: null, updated_session_id: null, updated_event_id: null, completed_kind: null, completed_session_id: null, completed_event_id: null, completed_user_id: null, completed_at: null, created_at: now, updated_at: now };
}
const settings: OrchestrationSettings = {
  key: "card_orchestration", version: 1, updatedAt: "2026-10-01T12:00:00Z", updatedBy: "admin",
  policy: { enabled: true, usageMaxAgeMs: 300000, sessionFolderId: null, systemFolderParentId: null,
    candidates: [{ agentId: "ariella-orchestrator", nodeId: "node", modelPreset: "claude-opus", minimumRemainingPercent: 15 }] },
};
type DecisionSession = { status: string; last_assistant_text: string; termination_event_id: number; metadata: unknown };
/** Shared durable state survives constructing another coordinator. Claims mirror SQL CAS/lease semantics. */
function durableState() {
  return {
    now: 0, sequence: 0, lastHash: null as string | null,
    runs: new Map<string, OrchestrationRun>(), leases: new Map<string, number>(),
    sessions: new Map<string, DecisionSession>(), notes: [] as Array<{ state: string; reason: string | null }>,
    cards: [queuedCard()], occupancy: { node: 0 }, capacity: { default: 2 },
    quotaObservedAt: "2026-10-01T12:00:00Z", quotaRemaining: 50,
    instructionsRevision: "sha256:revision",
  };
}
type DurableState = ReturnType<typeof durableState>;
function harness(state = durableState(), options: {
  beforeDecision?: (run: OrchestrationRun) => Promise<void>;
  decision?: (run: OrchestrationRun) => OrchestrationDecision;
} = {}) {
  const activeRun = () => [...state.runs.values()].find(run => ["reserved", "judging", "decided"].includes(run.state)) ?? null;
  const owns = (run: OrchestrationRun) => state.runs.get(run.id)?.lease_token === run.lease_token && (state.leases.get(run.id) ?? 0) > state.now;
  const repository = {
    note: vi.fn(async (status: string, reason: string | null) => { state.notes.push({ state: status, reason }); }),
    active: vi.fn(async () => { const run = activeRun(); return run ? structuredClone(run) : null; }),
    isDuplicate: vi.fn(async (hash: string) => state.lastHash === hash),
    unavailableTargets: vi.fn(async () => []),
    workExpired: vi.fn(async () => false),
    claim: vi.fn(async (input: Parameters<CardOrchestrationRepository["claim"]>[0]) => {
      if (state.lastHash === input.inputHash) return null;
      const active = activeRun();
      if (active) {
        if ((state.leases.get(active.id) ?? 0) > state.now) return null;
        active.lease_token = `lease-${++state.sequence}`;
        state.leases.set(active.id, state.now + 45000);
        return structuredClone(active);
      }
      const number = ++state.sequence;
      const run: OrchestrationRun = { id: `run-${number}`, input_hash: input.inputHash, policy_version: input.policyVersion, snapshot: structuredClone(input.snapshot), target: structuredClone(input.target), session_id: `decision-${number}`, execution_token: `execution-${number}`, lease_token: `lease-${number}`, state: "reserved", decision: null, execution_claimed: false, instructions_revision: input.instructionsRevision ?? null };
      state.runs.set(run.id, run);
      state.leases.set(run.id, state.now + 45000);
      return structuredClone(run);
    }),
    renew: vi.fn(async (run: OrchestrationRun) => {
      if (!owns(run)) return null;
      state.leases.set(run.id, state.now + 45000);
      return structuredClone(state.runs.get(run.id)!);
    }),
    prepareLaunch: vi.fn(async (run: OrchestrationRun) => {
      if (!owns(run) || state.runs.get(run.id)?.state !== "reserved") return false;
      state.runs.get(run.id)!.state = "judging";
      return true;
    }),
    session: vi.fn(async (run: OrchestrationRun) => state.sessions.get(run.session_id) ?? null),
    decide: vi.fn(async (run: OrchestrationRun, decision: OrchestrationDecision) => {
      if (!owns(run) || state.runs.get(run.id)?.state !== "judging") return false;
      Object.assign(state.runs.get(run.id)!, { state: "decided", decision: structuredClone(decision) });
      return true;
    }),
    finish: vi.fn(async (run: OrchestrationRun, status: OrchestrationRun["state"], reason: string | null) => {
      if (!owns(run)) return;
      state.runs.get(run.id)!.state = status;
      if (status === "completed") state.lastHash = run.input_hash;
      state.notes.push({ state: status, reason });
    }),
    pendingWorkers: vi.fn(async ():Promise<WorkerDispatch[]> => []),
    workerObserved: vi.fn(async () => false),
  };
  const getCard = vi.fn(async (id: string) => {
    const card = state.cards.find(value => value.id === id);
    return card ? { card: structuredClone(card), questions: [] as Array<{text:string;answer:string|null}>, comments: [] } : null;
  });
  const recordDispatch = vi.fn(async () => { throw new Error("These cost tests defer; worker admission would violate the fixture"); });
  const dispatch = {
    queued: vi.fn(async () => structuredClone(state.cards.filter(card => card.status === "queued"))),
    limited: vi.fn(async () => []), running: vi.fn(async () => []),
    occupancy: vi.fn(async () => ({ ...state.occupancy })),
    settings: vi.fn(async () => ({ nodeConcurrency: { ...state.capacity } })),
    rejectionReason: vi.fn(async () => null),
  };
  const ensureFolder = vi.fn(async () => "system-folder");
  const launchDecision = vi.fn(async ({ run }: Parameters<CoordinatorOptions["launchDecision"]>[0]) => {
    await options.beforeDecision?.(run);
    const decision = options.decision?.(run) ?? { decisions: run.snapshot.map(card => ({ cardId: card.cardId, cardVersion: card.cardVersion, action: "defer" as const, reason: "우선순위 검토 후 보류" })) };
    state.sessions.set(run.session_id, { status: "completed", last_assistant_text: JSON.stringify(decision), termination_event_id: 1, metadata: [{ type: "card_orchestration_decision", runId: run.id, leaseToken: run.execution_token, instructionsRevision: run.instructions_revision ?? "sha256:revision" }] });
  });
  const settingsRead = vi.fn(async () => structuredClone(settings));
  const warn = vi.fn();
  const coordinator = new CardOrchestrationCoordinator({
    repository: repository as unknown as CardOrchestrationRepository,
    dispatch: dispatch as unknown as CardDispatchRepository,
    cards: async () => ({ getCard, recordDispatch } as unknown as CardControlPlaneService),
    settings: settingsRead,
    resolveTarget: () => ({ nodeId: "node", agentId: "worker", modelPreset: "worker-preset", available: true, reason: null }),
    selectOrchestrator: async candidates => {
      const provider = { status: "auto" as const, source: "claude-api", sourceKind: "remote" as const, observedAt: state.quotaObservedAt, weeklyRemainingPercent: state.quotaRemaining, weeklyResetAt: null, shortRemainingPercent: state.quotaRemaining, shortResetAt: null, quotas: [{ id: "claude:5h", label: "5시간", window: "5h", model: null, remainingPercent: state.quotaRemaining, resetAt: null, purpose: "execution" as const }] };
      const snapshot = { generatedAt: state.quotaObservedAt, collectedAt: state.quotaObservedAt, nodes: [{ nodeId: "node", fetchedAt: state.quotaObservedAt, stale: false, staleSince: null, providers: { claude: provider, codex: null, gemini: null } }] };
      for (const candidate of candidates) {
        const usage = strictOrchestrationUsage(candidate.nodeId, { usage_provider: "claude", usage_model_id: "opus" }, snapshot, new Date(Date.parse("2026-10-01T12:00:00Z") + state.now), candidate.minimumRemainingPercent);
        if (usage.available) return { candidate, reason: null, instructionsRevision: state.instructionsRevision };
      }
      return { candidate: null, reason: "quota_below_threshold" };
    },
    ensureFolder, launchDecision, launchWorker: vi.fn(), sendMessage: vi.fn(), warn,
  });
  return { state, coordinator, repository, dispatch, settingsRead, launchDecision, ensureFolder, recordDispatch, getCard, warn };
}
async function finishJudgement(h: ReturnType<typeof harness>) {
  await h.coordinator.kick();
  await h.coordinator.decisionEnded([...h.state.runs.values()].at(-1)!.session_id);
  expect([...h.state.runs.values()].at(-1)?.state).toBe("completed");
}

describe("card orchestration logical-input cost and durable replay", () => {
  it("includes explicitly queued cards with unanswered questions in the decision snapshot",async()=>{
    const h=harness();
    h.getCard.mockImplementation(async()=>({card:structuredClone(h.state.cards[0]!),questions:[{text:"판단",answer:null},{text:"기존 답",answer:"진행"}],comments:[]}));
    await finishJudgement(h);
    expect(h.launchDecision).toHaveBeenCalledTimes(1);
    expect(h.launchDecision.mock.calls[0]![0].run.snapshot).toEqual([expect.objectContaining({cardId:"queued-1",answers:[{text:"기존 답",answer:"진행"}]})]);
  });
  it("keeps accepted but unstarted cards pending across duplicate ticks and restart", async () => {
    const state=durableState();
    for (const h of [harness(state),harness(state)]) {
      h.repository.pendingWorkers.mockImplementation(async()=>[{
        card_id:state.cards[0]!.id,run_id:"pending-run",session_id:"owner",node_id:"node",
        input:{deliveryId:"pending-delivery"},state:"launching",launch_token:"token",launch_accepted:true,expired:false,
      }]);
      await h.coordinator.kick();
      await h.coordinator.kick();
      expect(h.launchDecision).not.toHaveBeenCalled();
      expect(h.recordDispatch).not.toHaveBeenCalled();
      expect(h.state.cards[0]!.status).toBe("queued");
      expect(h.repository.workerObserved).toHaveBeenCalled();
      expect(h.warn).not.toHaveBeenCalled();
    }
  });
  it("calls the model once for repeated unchanged polls and sufficient quota observation refreshes", async () => {
    const h = harness();
    await finishJudgement(h);
    for (let i = 0; i < 4; i++) await h.coordinator.kick();
    h.state.now = 60000;
    h.state.quotaObservedAt = "2026-10-01T12:01:00Z";
    h.state.quotaRemaining = 80;
    await h.coordinator.kick();
    expect(h.launchDecision).toHaveBeenCalledTimes(1);
    expect(h.ensureFolder).toHaveBeenCalledTimes(1);
    expect(h.recordDispatch).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });
  it("asks once more after a meaningful candidate revision changes", async () => {
    const h = harness();
    await finishJudgement(h);
    h.state.cards[0]!.version++;
    h.state.cards[0]!.request = "수정한 실제 지시";
    await finishJudgement(h);
    await h.coordinator.kick();
    expect(h.launchDecision).toHaveBeenCalledTimes(2);
  });
  it("asks once more when canonical orchestration instructions change", async () => {
    const h = harness();
    await finishJudgement(h);
    h.state.instructionsRevision = "sha256:new-instructions";
    await finishJudgement(h);
    await h.coordinator.kick();
    expect(h.launchDecision).toHaveBeenCalledTimes(2);
    expect(h.launchDecision.mock.calls[1]?.[0].run.instructions_revision).toBe("sha256:new-instructions");
  });
  it("retains completed input identity across coordinator restart without another model call", async () => {
    const state = durableState();
    const first = harness(state);
    await finishJudgement(first);
    const restarted = harness(state);
    await restarted.coordinator.kick();
    expect(first.launchDecision).toHaveBeenCalledTimes(1);
    expect(restarted.launchDecision).not.toHaveBeenCalled();
    expect(restarted.ensureFolder).not.toHaveBeenCalled();
  });
  it("recovers expired judging intent after restart with the same session and stable execution fence", async () => {
    const state = durableState();
    const first = harness(state);
    await first.coordinator.kick();
    const original = structuredClone([...state.runs.values()][0]!);
    state.now = 46000;
    const restarted = harness(state);
    await restarted.coordinator.kick();
    expect(state.runs.get(original.id)).toMatchObject({ state: "completed", session_id: original.session_id, execution_token: original.execution_token });
    expect(state.runs.get(original.id)?.lease_token).not.toBe(original.lease_token);
    expect(restarted.launchDecision).not.toHaveBeenCalled();
  });
  it("does not duplicate a decision launch from concurrent coordinator instances", async () => {
    const state = durableState();
    const first = harness(state), second = harness(state);
    await Promise.all([first.coordinator.kick(), second.coordinator.kick()]);
    expect(first.launchDecision.mock.calls.length + second.launchDecision.mock.calls.length).toBe(1);
    expect(state.runs.size).toBe(1);
  });
  it("preserves a dirty revision trigger received while judgment is awaiting and processes the new snapshot", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const h = harness(undefined, { beforeDecision: async () => {
      if (!first) return;
      first = false;
      entered();
      await waiting;
    } });
    const pending = h.coordinator.kick();
    await Promise.race([started, pending.then(() => { throw new Error(`Judgment did not start: ${h.warn.mock.calls.flat().join(" ")}`); })]);
    h.state.cards[0]!.version++;
    h.state.cards[0]!.request = "판단 도중 바뀐 요청";
    const dirty = h.coordinator.kick();
    release();
    await Promise.all([pending, dirty]);
    expect(h.launchDecision).toHaveBeenCalledTimes(2);
    expect(h.launchDecision.mock.calls[1]?.[0].run.snapshot[0]?.cardVersion).toBe(2);
    expect(h.warn).not.toHaveBeenCalled();
  });
  it("reclaims its own expired lease instead of remaining stuck after a slow judgment", async () => {
    const h = harness();
    await h.coordinator.kick();
    h.state.now = 46000;
    await h.coordinator.kick();
    expect([...h.state.runs.values()][0]?.state).toBe("completed");
    expect(h.launchDecision).toHaveBeenCalledTimes(1);
  });
  it("creates no judgment or lazy folder for empty queue, full capacity or unavailable quota", async () => {
    for (const skip of ["empty", "capacity", "quota"] as const) {
      const h = harness();
      if (skip === "empty") h.state.cards = [];
      if (skip === "capacity") h.state.occupancy.node = 2;
      if (skip === "quota") h.state.quotaRemaining = 0;
      await h.coordinator.kick();
      expect(h.launchDecision).not.toHaveBeenCalled();
      expect(h.ensureFolder).not.toHaveBeenCalled();
      expect(h.state.runs.size).toBe(0);
    }
  });
});

describe("validated advertised preset accessor", () => {
  it("exposes provider scope without ordinary permissive availability and rejects missing/offline nodes", () => {
    const preset = { id: "claude-opus", label: "Opus", backend: "claude", available: true, usage_provider: "claude", usage_model_id: "opus" };
    const service = new ModelPresetAvailabilityService({ getConnectedNode: id => id === "node" ? { nodeId: "node", modelPresets: [preset] } as NodeConnectionSnapshot : undefined }, { getSummary: () => ({ generatedAt: "", collectedAt: null, nodes: [] }) });
    expect(service.resolveStaticForNode("node", "claude-opus")).toEqual(preset);
    expect(() => service.resolveStaticForNode("node", "missing")).toThrow("not advertised");
    expect(() => service.resolveStaticForNode("offline", "claude-opus")).toThrow("not advertised");
  });
});

it("persists card attachments in the central worker admission before launch",async()=>{
 const attachments=[{nodeId:"node",path:"/incoming/upload/image.png",name:"image.png",mimeType:"image/png"}];
 const state=durableState();state.cards[0]!.attachments=attachments;
 const h=harness(state,{decision:run=>({decisions:run.snapshot.map(card=>({cardId:card.cardId,cardVersion:card.cardVersion,action:"run",reason:"실행"}))})});
 h.recordDispatch.mockImplementation(async()=>undefined as never);
 await finishJudgement(h);
 expect(h.recordDispatch).toHaveBeenCalledWith(expect.objectContaining({admission:expect.objectContaining({workerInput:expect.objectContaining({attachments})})}));
});

it("keeps the admission declaration and adds check-item guidance to an automatic worker prompt",async()=>{
 const h=harness(undefined,{decision:run=>({decisions:run.snapshot.map(card=>({cardId:card.cardId,cardVersion:card.cardVersion,action:"run" as const,reason:"실행"}))})});
 h.getCard.mockImplementation(async()=>({card:structuredClone(h.state.cards[0]!),questions:[],comments:[{
   id:"user-comment",created_at:new Date("2026-10-01T12:00:00Z"),body:"확인할 결과를 추가해 주세요",
 }]} as any));
 h.recordDispatch.mockImplementation(async()=>undefined as never);
 await finishJudgement(h);
 const persisted=(h.recordDispatch.mock.calls as unknown as Array<[{
   admission:{workerInput:{prompt:string}}
 }]>)[0]![0];
 expect(persisted.admission.workerInput.prompt).toContain("커멘트 ID: user-comment");
 expect(persisted.admission.workerInput.prompt).toContain("전달을 읽기만 한 상태는 착수가 아닙니다.");
 expect(persisted.admission.workerInput.prompt).toContain("착수 성공 뒤 확인 항목이 없으면 set_card_items로 결과를 나누고, 이미 있으면 그 항목을 이어서 씁니다.");
});

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
function runningCard(id: string, patch: Partial<DispatchCard> = {}): DispatchCard {
  return { ...queuedCard(), id, title: id, status: "running", request: "running request", brief: "running brief", ...patch };
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
    now: 0, sequence: 0,
    completedRuns: [] as Array<{ inputHash: string; createdAt: number }>,
    runs: new Map<string, OrchestrationRun>(), leases: new Map<string, number>(),
    sessions: new Map<string, DecisionSession>(), notes: [] as Array<{ state: string; reason: string | null }>,
    cards: [queuedCard()], occupancy: { node: 0 } as Record<string, number>, capacity: { default: 2 },
    runningCards: [] as DispatchCard[], ownerSessions: new Map<string, Record<string, unknown>>(),
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
    isDuplicate: vi.fn(async (hash: string) => state.completedRuns.some(run => run.inputHash === hash && run.createdAt > state.now - 600000)),
    unavailableTargets: vi.fn(async () => []),
    workExpired: vi.fn(async () => false),
    claim: vi.fn(async (input: Parameters<CardOrchestrationRepository["claim"]>[0]) => {
      if (state.completedRuns.some(run => run.inputHash === input.inputHash && run.createdAt > state.now - 600000)) return null;
      const active = activeRun();
      if (active) {
        if ((state.leases.get(active.id) ?? 0) > state.now) return null;
        active.lease_token = `lease-${++state.sequence}`;
        state.leases.set(active.id, state.now + 45000);
        return structuredClone(active);
      }
      const number = ++state.sequence;
      const run: OrchestrationRun = { id: `run-${number}`, input_hash: input.inputHash, policy_version: input.policyVersion, snapshot: structuredClone(input.snapshot), target: structuredClone(input.target), session_id: `decision-${number}`, execution_token: `execution-${number}`, lease_token: `lease-${number}`, state: "reserved", decision: null, execution_claimed: false, instructions_revision: input.instructionsRevision ?? null, input_context: structuredClone(input.context ?? {}) };
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
      if (status === "completed") state.completedRuns.push({ inputHash: run.input_hash, createdAt: state.now });
      state.notes.push({ state: status, reason });
    }),
    pendingWorkers: vi.fn(async ():Promise<WorkerDispatch[]> => []),
    workerObserved: vi.fn(async () => false),
  };
  const getCard = vi.fn(async (id: string) => {
    const card = state.cards.find(value => value.id === id);
    return card ? { card: structuredClone(card), questions: [] as Array<{text:string;answer:string|null}>, comments: [], reports: [] } : null;
  });
  const recordDispatch = vi.fn(async () => { throw new Error("These cost tests defer; worker admission would violate the fixture"); });
  const resumeDispatchedCard = vi.fn(async () => { throw new Error("These cost tests do not resume workers"); });
  const dispatch = {
    queued: vi.fn(async () => structuredClone(state.cards.filter(card => card.status === "queued"))),
    limited: vi.fn(async () => structuredClone(state.cards.filter(card => card.status === "blocked" && card.blocked_kind === "limit"))),
    running: vi.fn(async () => structuredClone(state.runningCards)),
    occupancy: vi.fn(async () => ({ ...state.occupancy })),
    settings: vi.fn(async () => ({ nodeConcurrency: { ...state.capacity } })),
    ownerSession: vi.fn(async (id: string) => state.ownerSessions.get(id) ?? null),
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
    cards: async () => ({ getCard, recordDispatch, resumeDispatchedCard } as unknown as CardControlPlaneService),
    settings: settingsRead,
    resolveTarget: () => ({ nodeId: "node", agentId: "worker", modelPreset: "worker-preset", available: true, reason: null }),
    selectOrchestrator: async candidates => {
      const provider = { status: "auto" as const, source: "claude-api", sourceKind: "remote" as const, observedAt: state.quotaObservedAt, weeklyRemainingPercent: state.quotaRemaining, weeklyResetAt: null, shortRemainingPercent: state.quotaRemaining, shortResetAt: null, quotas: [{ id: "claude:5h", label: "5시간", window: "5h", model: null, remainingPercent: state.quotaRemaining, resetAt: null, purpose: "execution" as const }] };
      const snapshot = { generatedAt: state.quotaObservedAt, collectedAt: state.quotaObservedAt, nodes: [{ nodeId: "node", fetchedAt: state.quotaObservedAt, stale: false, staleSince: null, providers: { claude: provider, codex: null, antigravity: null } }] };
      for (const candidate of candidates) {
        const usage = strictOrchestrationUsage(candidate.nodeId, { usage_provider: "claude", usage_model_id: "opus" }, snapshot, new Date(Date.parse("2026-10-01T12:00:00Z") + state.now), candidate.minimumRemainingPercent);
        if (usage.available) return { candidate, reason: null, instructionsRevision: state.instructionsRevision };
      }
      return { candidate: null, reason: "quota_below_threshold" };
    },
    ensureFolder, launchDecision, launchWorker: vi.fn(), sendMessage: vi.fn(), warn,
  });
  return { state, coordinator, repository, dispatch, settingsRead, launchDecision, ensureFolder, recordDispatch, resumeDispatchedCard, getCard, warn };
}
async function finishJudgement(h: ReturnType<typeof harness>) {
  await h.coordinator.kick();
  await h.coordinator.decisionEnded([...h.state.runs.values()].at(-1)!.session_id);
  expect([...h.state.runs.values()].at(-1)?.state).toBe("completed");
}

describe("card orchestration logical-input cost and durable replay", () => {
  it("includes explicitly queued cards with unanswered questions in the decision snapshot",async()=>{
    const h=harness();
    h.getCard.mockImplementation(async()=>({card:structuredClone(h.state.cards[0]!),questions:[{text:"판단",answer:null},{text:"기존 답",answer:"진행"}],comments:[],reports:[]}));
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
  it("does not judge a blocked limit card whose owner ended for another reason", async () => {
    const h = harness();
    h.state.cards[0] = { ...h.state.cards[0]!, status: "blocked", blocked_kind: "limit", assignee_session_id: "owner" };
    h.state.ownerSessions.set("owner", { status: "error", termination_reason: "error_aborted", termination_event_id: 12 });
    await h.coordinator.kick();
    expect(h.launchDecision).not.toHaveBeenCalled();
    expect(h.ensureFolder).not.toHaveBeenCalled();
    expect(h.repository.note).toHaveBeenCalledWith("skipped", "limit_owner_not_resumable");
  });
  it("ignores running card text changes but judges membership and status changes", async () => {
    const h = harness();
    h.state.runningCards.push(runningCard("active-1"));
    await finishJudgement(h);
    h.state.runningCards[0]!.brief = "changed handoff text";
    await h.coordinator.kick();
    expect(h.launchDecision).toHaveBeenCalledTimes(1);
    h.state.runningCards[0]!.status = "blocked";
    await finishJudgement(h);
    expect(h.launchDecision).toHaveBeenCalledTimes(2);
  });
  it("fingerprints only free slots on candidate target nodes", async () => {
    const h = harness();
    await finishJudgement(h);
    h.state.occupancy.other = 1;
    await h.coordinator.kick();
    expect(h.launchDecision).toHaveBeenCalledTimes(1);
    h.state.occupancy.node = 1;
    await finishJudgement(h);
    expect(h.launchDecision).toHaveBeenCalledTimes(2);
  });
  it("remembers A after judging B and expires that memory after ten minutes", async () => {
    const h = harness();
    await finishJudgement(h);
    h.state.runningCards.push(runningCard("active-1"));
    await finishJudgement(h);
    h.state.runningCards = [];
    await h.coordinator.kick();
    expect(h.launchDecision).toHaveBeenCalledTimes(2);

    h.state.now = 600001;
    h.state.quotaObservedAt = new Date(Date.parse("2026-10-01T12:00:00Z") + h.state.now).toISOString();
    await finishJudgement(h);
    await h.coordinator.kick();
    expect(h.launchDecision).toHaveBeenCalledTimes(3);
  });
  it("bounds judgment text and keeps the latest comments, reports, and running task text", async () => {
    const h = harness();
    const card = { ...h.state.cards[0]!, request: "candidate request" };
    h.state.runningCards.push(runningCard("active-1", {
      request: `running-request-head-${"r".repeat(1000)}-running-request-tail`,
      brief: `running-brief-head-${"b".repeat(1200)}-running-brief-tail`,
    }));
    const comments = Array.from({ length: 4 }, (_, i) => ({
      id: `comment-${i}`,
      created_at: new Date(Date.UTC(2026, 0, i + 1)),
      body: `comment-${i}-head${"c".repeat(1200)}-tail-${i}`,
    }));
    const reports = [3, 2, 1].map(i => ({
      id: `report-${i}`,
      title: `report-${i}-title-${"t".repeat(240)}`,
      format: "markdown",
      body: `report-${i}-head${"p".repeat(2400)}-tail-${i}`,
      created_at: new Date(Date.UTC(2026, 1, i)),
    }));
    h.getCard.mockImplementation(async () => ({
      card: { ...card, latest_activity: { body: `activity-head${"a".repeat(2400)}-activity-tail` } } as never,
      questions: [], comments, reports,
    } as never));
    await h.coordinator.kick();

    const prompt = JSON.parse(h.launchDecision.mock.calls[0]![0].prompt) as {
      candidates: Array<Record<string, unknown>>;
      context: { running: Array<Record<string, string>>; capacity: Record<string, number> };
    };
    const candidate = prompt.candidates[0]!;
    const snapshotComments = candidate.comments as Array<{ body: string }>;
    const snapshotReports = candidate.reports as Array<{ title: string; body: string }>;
    const snapshotCard = candidate.card as { latest_activity: { body: string } };
    expect(snapshotComments).toHaveLength(3);
    expect(candidate.omittedComments).toBe(1);
    expect(snapshotComments[2]?.body).toMatch(/^comment-3-head/);
    expect(snapshotComments[2]?.body.endsWith("-tail-3")).toBe(true);
    expect(snapshotComments.every(comment => [...comment.body].length <= 1000)).toBe(true);
    expect(snapshotReports).toHaveLength(2);
    expect(candidate.omittedReports).toBe(1);
    expect(snapshotReports[1]?.title).toMatch(/^report-3-title-/);
    expect([...snapshotReports[1]!.title].length).toBeLessThanOrEqual(200);
    expect(snapshotReports.every(report => [...report.body].length <= 2000)).toBe(true);
    expect(snapshotCard.latest_activity.body.startsWith("activity-head")).toBe(true);
    expect(snapshotCard.latest_activity.body.endsWith("-activity-tail")).toBe(true);
    expect([...snapshotCard.latest_activity.body].length).toBeLessThanOrEqual(2000);
    expect([...prompt.context.running[0]!.request!].length).toBeLessThanOrEqual(600);
    expect(prompt.context.running[0]!.request).toMatch(/^running-request-head-/);
    expect(prompt.context.running[0]!.request!.endsWith("-running-request-tail")).toBe(true);
    expect([...prompt.context.running[0]!.brief!].length).toBeLessThanOrEqual(800);
    expect(prompt.context.running[0]!.brief).toMatch(/^running-brief-head-/);
    expect(prompt.context.running[0]!.brief!.endsWith("-running-brief-tail")).toBe(true);
    expect(prompt.context.capacity).toEqual({ node: 2 });
    expect([...h.launchDecision.mock.calls[0]![0].run.input_context!.running as unknown as string[]]).toEqual(prompt.context.running);
  });
  it("keeps the original worker prompt and warns when a decided run becomes unresumable", async () => {
    const longRequest = "request-" + "r".repeat(1500);
    const longBrief = "brief-" + "b".repeat(1100);
    const longComment = "comment-" + "c".repeat(1300);
    const h = harness(undefined, { decision: run => ({ decisions: run.snapshot.map(card => ({ cardId: card.cardId, cardVersion: card.cardVersion, action: "run" as const, reason: "execute" })) }) });
    h.state.cards[0] = { ...h.state.cards[0]!, request: longRequest, brief: longBrief };
    h.getCard.mockImplementation(async () => ({
      card: structuredClone(h.state.cards[0]!), questions: [], reports: [],
      comments: [{ id: "worker-comment", created_at: new Date("2026-10-01T12:00:00Z"), body: longComment }],
    } as never));
    await h.coordinator.kick();
    await h.coordinator.decisionEnded("decision-1");
    const workerInput = (h.recordDispatch.mock.calls[0] as unknown as [{ admission: { workerInput: { prompt: string } } }])[0].admission.workerInput;
    expect(workerInput.prompt).toContain(longRequest);
    expect(workerInput.prompt).toContain(longBrief);
    expect(workerInput.prompt).toContain(longComment);
    expect(workerInput.prompt).not.toContain("[중간 생략]");

    const skipped = harness(undefined, { decision: run => ({ decisions: run.snapshot.map(card => ({ cardId: card.cardId, cardVersion: card.cardVersion, action: "run" as const, reason: "execute" })) }) });
    await skipped.coordinator.kick();
    skipped.state.cards[0] = { ...skipped.state.cards[0]!, status: "blocked", blocked_kind: "limit", assignee_session_id: "owner" };
    skipped.state.ownerSessions.set("owner", { status: "error", termination_reason: "error_aborted", termination_event_id: 12 });
    await skipped.coordinator.decisionEnded("decision-1");
    expect(skipped.warn).toHaveBeenCalledWith("card queued-1 run skipped: limit_owner_not_resumable");
    expect(skipped.recordDispatch).not.toHaveBeenCalled();
    expect(skipped.resumeDispatchedCard).not.toHaveBeenCalled();
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
    const service = new ModelPresetAvailabilityService({ getConnectedNode: id => id === "node" ? { nodeId: "node", modelPresets: [preset] } as NodeConnectionSnapshot : undefined }, { getSummary: () => ({ generatedAt: "", collectedAt: null, nodes: [] }), getLimitRejection: () => null });
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
 expect(persisted.admission.workerInput.prompt).toMatch(/\n\n## 지금 실행 중인 다른 카드 세션\n[^]*\n\n자동 배정 실행이다\. 일을 시작할 때 get_card로 version을 읽어 start_card_work를 부른다\.$/);
 expect(persisted.admission.workerInput.prompt).not.toContain("## 카드 규칙");
 expect(persisted.admission.workerInput.prompt).not.toContain("## 대기열");
});

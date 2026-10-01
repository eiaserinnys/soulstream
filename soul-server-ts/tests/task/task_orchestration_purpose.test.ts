import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { SessionDB, SessionRow } from "../../src/db/session_db.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { TaskManager } from "../../src/task/task_manager.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { hydrateEvictedTaskFromSessionRow } from "../../src/task/task_evicted_hydration.js";
import { makeTaskCreationHarness } from "./task_creation_harness.js";
// These guards do not resolve any model preset. Avoid pulling unrelated catalog parsing into the unit boundary.
vi.mock("../../src/model_catalog.js", () => ({ UnknownModelPresetError: class extends Error {} }));
const purpose = { runId: "run-1", leaseToken: "execution-fence-1", instructionsRevision: "sha256:revision" };
const logger = pino({ level: "silent" });
function task(fields: Partial<Task> = {}): Task {
  return { agentSessionId: "decision", prompt: "candidate data", status: "completed", sessionType: "llm", createdAt: new Date(), lastEventId: 0, lastReadEventId: 0, interventionQueue: [], ...fields };
}
function row(fields: Partial<SessionRow> = {}): SessionRow {
  return { session_id: "decision", node_id: "node", status: "completed", session_type: "llm", agent_id: "ariella-orchestrator", metadata: [{ type: "card_orchestration_decision", ...purpose }], created_at: new Date(), updated_at: new Date(), ...fields } as SessionRow;
}
function manager(value?: Task, durable?: SessionRow) {
  const getSession = vi.fn(async () => durable ?? null);
  const registerSession = vi.fn(async () => undefined);
  const persistence = { enqueueMetadataEffect: vi.fn(async () => 1) };
  const result = new TaskManager("node", { getSession } as unknown as SessionDB, {} as SessionBroadcaster, logger, persistence as never, undefined, undefined, undefined, undefined, false, undefined, undefined, { registerSession } as never);
  if (value) (result as unknown as { tasks: Map<string, Task> }).tasks.set(value.agentSessionId, value);
  return { result, getSession, registerSession };
}
describe("canonical card orchestration purpose", () => {
  it("persists server-only marker before visible creation and restores it exactly", async () => {
    const h = makeTaskCreationHarness();
    const value = await h.creation.createTask({ agentSessionId: "decision", prompt: "candidates", profileId: "ariella-orchestrator", sessionType: "llm", orchestrationPurpose: purpose });
    await h.creation.waitForDeferredEffects("decision");
    expect(value.orchestrationPurpose).toEqual(purpose);
    expect(h.appendMetadata).toHaveBeenCalledWith("decision", { type: "card_orchestration_decision", ...purpose }, { waitForAck: true });
    expect(h.appendMetadata.mock.invocationCallOrder[0]).toBeLessThan(h.emitSessionCreated.mock.invocationCallOrder[0]!);
    expect(hydrateEvictedTaskFromSessionRow(row(), logger)?.orchestrationPurpose).toEqual(purpose);
  });
  it.each([null, [], [{ type: "card_orchestration_decision", runId: "run" }], [{ type: "card_orchestration_decision", ...purpose }, { type: "card_orchestration_decision", ...purpose, leaseToken: "other" }]])("fails closed when reserved profile loses or corrupts marker %j", metadata => {
    expect(hydrateEvictedTaskFromSessionRow(row({ metadata }), logger)).toBeNull();
  });
  it("rejects invalid purpose creation and generic reserved identity before persistence", async () => {
    const h = makeTaskCreationHarness();
    await expect(h.creation.createTask({ agentSessionId: "bad", prompt: "", sessionType: "claude", orchestrationPurpose: purpose })).rejects.toThrow("card orchestration");
    const { result, registerSession } = manager();
    await expect(result.createTask({ agentSessionId: "generic", prompt: "", profileId: "ariella-orchestrator" })).rejects.toThrow("card orchestration");
    expect(h.registerSession).not.toHaveBeenCalled();
    expect(registerSession).not.toHaveBeenCalled();
  });
  it("rejects intervention, automatic resume and generic recovery for cached and hydrated purpose sessions", async () => {
    for (const durable of [false, true]) {
      const value = task({ profileId: "ariella-orchestrator", orchestrationPurpose: purpose });
      const { result } = manager(durable ? undefined : value, durable ? row() : undefined);
      const onResume = vi.fn();
      await expect(result.addIntervention({ agentSessionId: "decision", text: "run arbitrary tools", user: "test" }, onResume)).rejects.toThrow("card orchestration");
      expect(await result.resumeQueuedAfterTerminal(value, onResume)).toBe(false);
      expect(await result.hydrateRunnerRecoveryTask("decision")).toBeNull();
      expect(await result.getScheduleResumeState("decision")).toBeNull();
      expect(onResume).not.toHaveBeenCalled();
    }
  });
  it("refuses a purpose row masquerading as a normal agent session", () => {
    expect(hydrateEvictedTaskFromSessionRow(row({ session_type: "claude" }), logger)).toBeNull();
  });
  it("keeps normal hydration and generic recovery available", async () => {
    const normal = task({ profileId: "codex-default", sessionType: "claude" });
    expect(hydrateEvictedTaskFromSessionRow(row({ agent_id: "codex-default", metadata: [] }), logger)).not.toBeNull();
    const { result } = manager(normal);
    expect(await result.hydrateRunnerRecoveryTask("decision")).toBe(normal);
  });
  it.each([
    { profileId: "ariella-orchestrator" },
    { orchestrationPurpose: purpose },
    { metadata: [{ type: "card_orchestration_decision", broken: true }] },
  ])("blocks generic executor start and every adoption path for %j", async fields => {
    const executor = Object.create(TaskExecutor.prototype) as TaskExecutor;
    const value = task(fields);
    const agent = { id: "codex-default", name: "worker", backend: "codex", workspace_dir: "/tmp" } as never;
    expect(() => executor.startNewExecution(value, agent)).toThrow("card orchestration");
    expect(() => executor.startExecutionWithRunner(value, agent, {} as never)).toThrow("card orchestration");
    expect(() => executor.recoverRegisteredRunner(value, {} as never, undefined, "adopt")).toThrow("card orchestration");
    await expect(executor.recoverRunnerExecution(value, agent, {} as never)).rejects.toThrow("card orchestration");
    await expect(executor.retainRegisteredDetachedRunner(value, {} as never)).rejects.toThrow("card orchestration");
  });
});

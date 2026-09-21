import { describe, expect, it, vi } from "vitest";

import { RecurringJobScheduler } from "../src/recurring-jobs/scheduler.js";
import type { RecurringJobRepository } from "../src/recurring-jobs/types.js";
import type { RecurringJobService } from "../src/recurring-jobs/service.js";

describe("RecurringJobScheduler", () => {
  it("only reconciles committed session updates and never turns them into a second create", async () => {
    const reconcileSession = vi.fn(async () => null);
    const dispatchRun = vi.fn(async () => null);
    const reserveAndDispatchDueJob = vi.fn(async () => null);
    const scheduler = new RecurringJobScheduler({
      service: {
        reconcileSession,
        dispatchRun,
        reserveAndDispatchDueJob,
      } as unknown as RecurringJobService,
      repository: repository(),
    });

    scheduler.accept([
      {
        type: "node_session_session_updated",
        nodeId: "node-a",
        data: { agentSessionId: "session-uncommitted" },
      },
      {
        type: "node_session_session_updated",
        nodeId: "node-a",
        committedIngress: true,
        data: { session: { agent_session_id: "session-committed" } },
      },
    ]);
    await scheduler.drain();

    expect(reconcileSession).toHaveBeenCalledWith("session-committed");
    expect(reconcileSession).not.toHaveBeenCalledWith("session-uncommitted");
    expect(dispatchRun).not.toHaveBeenCalled();
    expect(reserveAndDispatchDueJob).not.toHaveBeenCalled();
  });
});

function repository(): RecurringJobRepository {
  return {
    findJobForOwner: async () => null,
    listJobsForOwner: async () => [],
    createJob: async () => { throw new Error("unused"); },
    findJobByCreateIdempotency: async () => null,
    updateJob: async () => { throw new Error("unused"); },
    archiveJob: async () => null,
    listRuns: async () => [],
    findRunByManualIdempotency: async () => null,
    findActiveRun: async () => null,
    createManualRun: async () => { throw new Error("unused"); },
    listDueJobs: async () => [],
    listActiveRuns: async () => [],
    getJob: async () => null,
    getRun: async () => null,
    getRunBySessionId: async () => null,
    updateRun: async () => { throw new Error("unused"); },
    reserveScheduledRun: async () => null,
    cancelAutomaticPendingRuns: async () => undefined,
    createScheduledRun: async () => { throw new Error("unused"); },
    advanceJobNextRun: async () => undefined,
  };
}

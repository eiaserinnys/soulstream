import { describe, expect, it, vi } from "vitest";

import type { SessionDeliveryRow } from "../../src/db/session_db_types.js";
import { TaskDeliveryLedgerGate } from "../../src/task/task_delivery_ledger_gate.js";

function row(deliveryId: string, state: SessionDeliveryRow["state"]): SessionDeliveryRow {
  return {
    delivery_id: deliveryId,
    state,
  } as SessionDeliveryRow;
}

describe("TaskDeliveryLedgerGate", () => {
  it("admits human live steering through the same durable ledger as every other delivery", async () => {
    const deliveryId = "77777777-7777-4777-8777-777777777777";
    const register = vi.fn(async () => ({
      row: {
        ...row(deliveryId, "pending"),
        aggregate_state: "pending",
      },
      inserted: true,
      conflict: false,
    }));
    const claimAttemptForTarget = vi.fn(async () => ({
      ...row(deliveryId, "claimed"),
      aggregate_state: "pending",
    }));
    const gate = new TaskDeliveryLedgerGate(true, {
      register,
      claimAttemptForTarget,
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
    });

    await expect(gate.admit({
      agentSessionId: "caller-1",
      text: "continue",
      user: "alice",
      deliveryId,
      deliveryIntent: "human_live_steer",
      completionId: `message:${deliveryId}`,
      relationKey: `user_message:caller-1:${deliveryId}`,
      source: "user_message",
    })).resolves.toMatchObject({ kind: "admitted", deliveryId });
    expect(register).toHaveBeenCalledOnce();
    expect(claimAttemptForTarget).toHaveBeenCalledWith(
      deliveryId,
      "caller-1",
      expect.stringMatching(/^route:/),
    );
  });

  it("keeps live-steer route result replayable until active-turn receipt", async () => {
    const deliveryId = "78787878-7878-4878-8878-787878787878";
    const markQueued = vi.fn(async () => ({
      ...row(deliveryId, "queued"),
      aggregate_state: "pending",
    }));
    const markConsumed = vi.fn(async () => ({
      ...row(deliveryId, "consumed"),
      aggregate_state: "consumed",
    }));
    const markDelivered = vi.fn();
    const markUncertain = vi.fn();
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimAttemptForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued,
      markDelivered,
      markUncertain,
      markConsumed,
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
    });

    await gate.recordResult({
      kind: "admitted",
      deliveryId,
      row: {
        ...row(deliveryId, "dispatching"),
        intent: "human_live_steer",
        attempt_token: "route-live",
      },
    }, { delivered: true });

    expect(markQueued).toHaveBeenCalledWith(
      deliveryId,
      "route-live",
    );
    expect(markDelivered).not.toHaveBeenCalled();
    expect(markConsumed).not.toHaveBeenCalled();
    expect(markUncertain).not.toHaveBeenCalled();
  });

  it("binds attachment, context, and caller_info into the payload identity", async () => {
    const register = vi.fn(async (params: { deliveryId: string }) => ({
      row: row(params.deliveryId, "pending"),
      inserted: true,
      conflict: false,
    }));
    const claimAttemptForTarget = vi.fn(
      async (deliveryId: string) => row(deliveryId, "claimed"),
    );
    const gate = new TaskDeliveryLedgerGate(true, {
      register,
      claimAttemptForTarget,
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
    });
    const base = {
      agentSessionId: "caller-1",
      text: "done",
      user: "agent",
      deliveryId: "99999999-9999-4999-8999-999999999999",
      deliveryIntent: "completion_notification" as const,
      completionId: "completion-1",
      relationKey: "child_session:child-1:42",
      source: "completion_notifier",
      context: [{ key: "task", content: "render" }],
      callerInfo: { source: "agent", agent_id: "child-1" },
    };

    await gate.admit({ ...base, attachmentPaths: ["/tmp/result.png"] });
    await gate.admit({
      ...base,
      deliveryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      attachmentPaths: ["/tmp/other.png"],
    });

    const first = register.mock.calls[0]![0];
    const second = register.mock.calls[1]![0];
    expect(first.payload).toMatchObject({
      attachment_paths: ["/tmp/result.png"],
      context: [{ key: "task", content: "render" }],
      caller_info: { source: "agent", agent_id: "child-1" },
    });
    expect(first.payloadHash).not.toBe(second.payloadHash);
  });

  it("routes an exact runtime replay through repository admission coalescing", async () => {
    const deliveryId = "91919191-9191-4919-8919-919191919191";
    const existing = {
      ...row(deliveryId, "consumed"),
      relation_key: "runtime-relation-1",
      completion_id: "runtime-completion-1",
      intent: "runtime_followup" as const,
      payload_hash: "stored-runtime-hash",
      payload: { text: "stored runtime payload" },
    };
    const register = vi.fn().mockResolvedValue({
      row: existing,
      inserted: false,
      conflict: false,
    });
    const get = vi.fn().mockResolvedValue(existing);
    const gate = new TaskDeliveryLedgerGate(true, {
      register,
      claimAttemptForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get,
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
    });

    await expect(gate.admit({
      agentSessionId: "caller-1",
      text: "runtime replay",
      user: "system",
      deliveryId,
      deliveryIntent: "runtime_followup",
      completionId: "runtime-completion-1",
      relationKey: "runtime-relation-1",
      source: "claude_runtime_task_followup",
      followupKey: "caller-1:task-1",
      followupAttempt: 3,
    })).resolves.toEqual({
      kind: "suppressed",
      deliveryId,
      reason: "delivery_consumed",
    });

    expect(register).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(deliveryId);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      payloadHash: "stored-runtime-hash",
      payload: { text: "stored runtime payload" },
    }));
  });

  it("records a child completion relation even before a notifier delivery row exists", async () => {
    const recordRelationConsumed = vi.fn().mockResolvedValue({
      relation: {},
      relationInserted: true,
      deliveryConsumed: false,
    });
    const markConsumed = vi.fn();
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimAttemptForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed,
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed,
    });

    await gate.recordConsumed({
      text: "child result already consumed inline",
      user: "agent",
      deliveryIntent: "completion_notification",
      completionId: "completion-child-42",
      relationKey: "child_session:child-1:42",
    }, {
      agentSessionId: "caller-1",
      prompt: "delegate",
      status: "running",
      createdAt: new Date(),
      lastEventId: 93,
      lastReadEventId: 0,
      interventionQueue: [],
    });

    expect(recordRelationConsumed).toHaveBeenCalledWith({
      relationKey: "child_session:child-1:42",
      completionId: "completion-child-42",
      callerSessionId: "caller-1",
      consumedTurnId: "event:93",
    });
    expect(markConsumed).not.toHaveBeenCalled();
  });

  it("fails closed when exact runtime consumption CAS misses unless the row is already consumed", async () => {
    const deliveryId = "bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc";
    const get = vi.fn()
      .mockResolvedValueOnce(row(deliveryId, "pending"))
      .mockResolvedValueOnce(row(deliveryId, "consumed"));
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimAttemptForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get,
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn().mockResolvedValue(null),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
    });
    const message = {
      text: "runtime followup",
      user: "system",
      source: "claude_runtime_task_followup",
      deliveryId,
      deliveryIntent: "runtime_followup" as const,
    };
    const task = {
      agentSessionId: "caller-1",
      prompt: "run",
      status: "running" as const,
      createdAt: new Date(),
      lastEventId: 94,
      lastReadEventId: 0,
      interventionQueue: [],
    };

    await expect(gate.recordConsumed(message, task)).rejects.toThrow(
      `Exact delivery consumption did not reach consumed state: ${deliveryId}`,
    );
    await expect(gate.recordConsumed(message, task)).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([
    { state: "consumed", aggregateState: "consumed" },
    { state: "superseded", aggregateState: "consumed" },
    { state: "uncertain", aggregateState: "dead_letter" },
  ] as const)(
    "accepts an already terminal $state/$aggregateState delivery as a late consumption observation",
    async ({ state, aggregateState }) => {
      const deliveryId = `terminal-${state}-${aggregateState}`;
      const existing = {
        ...row(deliveryId, state),
        aggregate_state: aggregateState,
      };
      const gate = new TaskDeliveryLedgerGate(true, {
        get: vi.fn().mockResolvedValue(existing),
        markConsumed: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(gate.recordConsumed({
        text: "already observed turn",
        user: "system",
        deliveryId,
        deliveryIntent: "runtime_followup",
      }, {
        agentSessionId: "caller-1",
        prompt: "run",
        status: "running",
        createdAt: new Date(),
        lastEventId: 95,
        lastReadEventId: 0,
        interventionQueue: [],
      })).resolves.toBeUndefined();
    },
  );

  it("propagates a completion-notification consumption repository error", async () => {
    const deliveryId = "bdbdbdbd-bdbd-4bdb-8bdb-bdbdbdbdbdbd";
    const repositoryError = new Error("delivery consume write failed");
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimAttemptForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn().mockRejectedValue(repositoryError),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
    });

    await expect(gate.recordConsumed({
      text: "completion notification",
      user: "agent",
      deliveryId,
      deliveryIntent: "completion_notification",
      completionId: "completion-notification-1",
      relationKey: "completion-notification-relation-1",
      source: "completion_notifier",
    }, {
      agentSessionId: "caller-1",
      prompt: "run",
      status: "running",
      createdAt: new Date(),
      lastEventId: 95,
      lastReadEventId: 0,
      interventionQueue: [],
    })).rejects.toBe(repositoryError);
  });

  it.each([
    "pending",
    "claimed",
    "dispatching",
    "queued",
    "delivered",
    "consumed",
    "superseded",
    "uncertain",
  ] as const)("reports the actual %s state when dispatch CAS loses", async (state) => {
    const deliveryId = `dispatch-cas-${state}`;
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimAttemptForTarget: vi.fn(),
      beginDispatch: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(row(deliveryId, state)),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
    });

    await expect(gate.beginDispatch({
      kind: "admitted",
      deliveryId,
      row: row(deliveryId, "claimed"),
    })).resolves.toEqual({
      kind: "suppressed",
      deliveryId,
      reason: `delivery_${state}_before_dispatch`,
    });
  });

  it("reports a missing row when dispatch CAS loses without durable evidence", async () => {
    const deliveryId = "dispatch-cas-missing";
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimAttemptForTarget: vi.fn(),
      beginDispatch: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(null),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
    });

    await expect(gate.beginDispatch({
      kind: "admitted",
      deliveryId,
      row: row(deliveryId, "claimed"),
    })).resolves.toEqual({
      kind: "suppressed",
      deliveryId,
      reason: "delivery_missing_before_dispatch",
    });
  });

  it("keeps an unknown first result retryable under the active dispatch attempt", async () => {
    const deliveryId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const markUncertain = vi.fn();
    const retryDeliveryAttempt = vi.fn().mockResolvedValue(row(deliveryId, "pending"));
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimAttemptForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain,
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
      retryDeliveryAttempt,
      markPendingSuperseded: vi.fn(),
    });

    await gate.recordResult({
      kind: "admitted",
      deliveryId,
      row: {
        ...row(deliveryId, "dispatching"),
        attempt_token: "route-uncertain",
        attempt_count: 0,
        created_at: new Date(),
      },
    }, {
      delivered: null,
      reason: "verdict_unknown",
      consumeWhen: null,
    });

    expect(retryDeliveryAttempt).toHaveBeenCalledWith(
      deliveryId,
      "route-uncertain",
      "verdict_unknown",
      expect.any(Number),
    );
    expect(markUncertain).not.toHaveBeenCalled();
  });

  it("treats a queued CAS miss as accepted when the durable row already advanced", async () => {
    const deliveryId = "edededed-eded-4ded-8ded-edededededed";
    const exactIdentity = {
      target_session_id: "caller-1",
      intent: "durable_next_turn" as const,
      relation_key: `user_message:caller-1:${deliveryId}`,
      completion_id: `message:${deliveryId}`,
      payload_hash: "hash-durable-acceptance",
    };
    const markQueued = vi.fn()
      .mockResolvedValueOnce(row(deliveryId, "queued"))
      .mockResolvedValueOnce(null);
    const get = vi.fn().mockResolvedValue({
      ...row(deliveryId, "queued"),
      ...exactIdentity,
    });
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimAttemptForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get,
      markQueued,
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
    });
    const admission = {
      kind: "admitted" as const,
      deliveryId,
      row: {
        ...row(deliveryId, "dispatching"),
        ...exactIdentity,
        attempt_token: "route-durable-acceptance",
      },
    };
    const result = { queued: true as const, reason: "session_busy" };

    await expect(gate.recordResult(admission, result)).resolves.toBeUndefined();
    await expect(gate.recordResult(admission, result)).resolves.toBeUndefined();

    expect(markQueued).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledWith(deliveryId);
  });

  it("rejects a queued CAS miss when the durable identity does not match", async () => {
    const deliveryId = "edededed-eded-4ded-8ded-edededededed";
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimAttemptForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get: vi.fn().mockResolvedValue({
        ...row(deliveryId, "queued"),
        target_session_id: "different-session",
        intent: "durable_next_turn",
        relation_key: `user_message:different-session:${deliveryId}`,
        completion_id: `message:${deliveryId}`,
        payload_hash: "different-hash",
      }),
      markQueued: vi.fn().mockResolvedValue(null),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
    });
    const admission = {
      kind: "admitted" as const,
      deliveryId,
      row: {
        ...row(deliveryId, "dispatching"),
        target_session_id: "caller-1",
        intent: "durable_next_turn" as const,
        relation_key: `user_message:caller-1:${deliveryId}`,
        completion_id: `message:${deliveryId}`,
        payload_hash: "hash-durable-acceptance",
        attempt_token: "route-durable-acceptance",
      },
    };

    await expect(gate.recordResult(admission, {
      queued: true,
      reason: "session_busy",
    })).rejects.toThrow(`Delivery ${deliveryId} lost queued-state CAS`);
  });

  it("supersedes only the pending durable retry selected by id", async () => {
    const deliveryId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const markPendingSuperseded = vi.fn().mockResolvedValue(
      row(deliveryId, "superseded"),
    );
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimAttemptForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
      retryDeliveryAttempt: vi.fn(),
      markPendingSuperseded,
    });

    await expect(gate.recordPendingSuperseded({
      text: "retry",
      user: "system",
      deliveryId,
      deliveryIntent: "runtime_followup",
    }, "user_message")).resolves.toBe(true);

    expect(markPendingSuperseded).toHaveBeenCalledWith(deliveryId, "user_message");
  });

  it("returns a queued reservation collision to the existing delivery retry ledger", async () => {
    const deliveryId = "abababab-abab-4bab-8bab-abababababab";
    const retryDeliveryAttempt = vi.fn().mockResolvedValue(row(deliveryId, "pending"));
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimAttemptForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
      retryDeliveryAttempt,
      markPendingSuperseded: vi.fn(),
    });
    const now = Date.parse("2026-08-19T00:09:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const retryAt = "2026-08-19T00:10:00.000Z";

    await expect(gate.recordReservationRetry({
      kind: "admitted",
      deliveryId,
      row: {
        ...row(deliveryId, "queued"),
        intent: "durable_next_turn",
        attempt_token: "route-reservation",
        attempt_count: 9,
        created_at: new Date(),
      },
    }, retryAt)).resolves.toBe("scheduled");
    nowSpy.mockRestore();

    expect(retryDeliveryAttempt).toHaveBeenCalledWith(
      deliveryId,
      "route-reservation",
      "reservation_in_flight",
      10_000,
    );
  });

  it("parks reservation retries after the active cadence is exhausted", async () => {
    const deliveryId = "acacacac-acac-4cac-8cac-acacacacacac";
    const markUncertain = vi.fn();
    const retryDeliveryAttempt = vi.fn().mockResolvedValue(
      row(deliveryId, "pending"),
    );
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimAttemptForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain,
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
      retryDeliveryAttempt,
      markPendingSuperseded: vi.fn(),
    });

    await expect(gate.recordReservationRetry({
      kind: "admitted",
      deliveryId,
      row: {
        ...row(deliveryId, "queued"),
        intent: "durable_next_turn",
        attempt_token: "route-exhausted",
        attempt_count: 15,
        created_at: new Date(),
      },
    }, "2026-08-19T00:10:00.000Z")).resolves.toBe("parked");

    expect(retryDeliveryAttempt).toHaveBeenCalledWith(
      deliveryId,
      "route-exhausted",
      "automatic attempt retry budget exhausted; explicit intent required",
      0,
    );
    expect(markUncertain).not.toHaveBeenCalled();
  });

});

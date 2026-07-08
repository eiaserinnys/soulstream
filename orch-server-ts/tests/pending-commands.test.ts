import { describe, expect, it } from "vitest";

import {
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
  PendingNodeCommands,
  loadContractFixtures,
  type RespondNodeCommandPayload,
  type SubscribeEventsNodeCommandPayload,
} from "../src/index.js";

describe("Pending node command primitive", () => {
  const fixture = loadContractFixtures().upstreamWsWire;

  function createPendingCommands(nowMs = 1_700_000_000_000): PendingNodeCommands {
    return new PendingNodeCommands({
      nowMs: () => nowMs,
      requestIdGenerator: ({ sequence, commandType, nowMs }) =>
        `req-${commandType}-${sequence}-${nowMs}`,
    });
  }

  function respondCommandPayload(): RespondNodeCommandPayload {
    const respond = fixture.outbound.respond;
    return {
      type: respond.type,
      agentSessionId: respond.agentSessionId,
      inputRequestId: respond.inputRequestId,
      answers: respond.answers,
    } satisfies RespondNodeCommandPayload;
  }

  it("creates deterministic command requestIds and resolves an ack by correlation id", async () => {
    const pending = createPendingCommands();
    const command = pending.createCommand(respondCommandPayload());

    expect(command.requestId).toBe("req-respond-1-1700000000000");
    expect(command.message).toMatchObject({
      type: "respond",
      agentSessionId: "sess-contract",
      inputRequestId: "input-req-contract",
      answers: { choice: "yes" },
      requestId: command.requestId,
    });
    expect(command.message.requestId).not.toBe(command.message.inputRequestId);
    expect(pending.pendingIds).toEqual([command.requestId]);

    const settlement = pending.settleFromResponse({
      ...fixture.inbound.commandAck,
      requestId: command.requestId,
    });

    await expect(command.result).resolves.toMatchObject({
      type: "session_created",
      requestId: command.requestId,
      agentSessionId: "sess-contract",
    });
    expect(settlement).toEqual({
      status: "resolved",
      requestId: command.requestId,
      commandType: "respond",
    });
    expect(pending.pendingCount).toBe(0);
  });

  it("rejects command error responses and removes the pending entry", async () => {
    const pending = createPendingCommands();
    const command = pending.createCommand(respondCommandPayload());

    const settlement = pending.settleFromResponse({
      ...fixture.inbound.commandError,
      requestId: command.requestId,
    });

    await expect(command.result).rejects.toBeInstanceOf(
      PendingNodeCommandRejectedError,
    );
    await expect(command.result).rejects.toMatchObject({
      commandType: "respond",
      requestId: command.requestId,
      message: "command failed",
    });
    expect(settlement).toEqual({
      status: "rejected",
      requestId: command.requestId,
      commandType: "respond",
      message: "command failed",
    });
    expect(pending.pendingCount).toBe(0);
  });

  it("expires pending commands by explicit sweep without real timers", async () => {
    const pending = new PendingNodeCommands({
      nowMs: () => 1_000,
      requestIdGenerator: ({ sequence }) => `req-${sequence}`,
    });
    const command = pending.createCommand(respondCommandPayload(), {
      timeoutMs: 250,
    });

    expect(pending.sweepExpired(1_249)).toEqual([]);
    expect(pending.pendingCount).toBe(1);

    expect(pending.sweepExpired(1_250)).toEqual([
      {
        requestId: "req-1",
        commandType: "respond",
        timeoutMs: 250,
        createdAtMs: 1_000,
        expiresAtMs: 1_250,
      },
    ]);
    await expect(command.result).rejects.toBeInstanceOf(
      PendingNodeCommandTimeoutError,
    );
    await expect(command.result).rejects.toThrow(
      "Command respond timed out after 250ms (requestId=req-1)",
    );
    expect(pending.pendingCount).toBe(0);
  });

  it("models subscribe_events as fire-and-forget and creates no pending entry", () => {
    const pending = createPendingCommands();
    const subscribeEvents = fixture.outbound.subscribeEvents;
    const command = pending.createFireAndForgetCommand({
      type: subscribeEvents.type,
      agentSessionId: subscribeEvents.agentSessionId,
      subscribeId: subscribeEvents.subscribeId,
    } satisfies SubscribeEventsNodeCommandPayload);

    expect(command.fireAndForget).toBe(subscribeEvents.fireAndForget);
    expect(command.message).toEqual({
      type: "subscribe_events",
      agentSessionId: "sess-contract",
      subscribeId: "<uuid>",
    });
    expect("requestId" in command.message).toBe(false);
    expect(pending.pendingCount).toBe(0);
  });

  it("ignores inbound messages without a matching command requestId", () => {
    const pending = createPendingCommands();

    expect(pending.settleFromResponse(fixture.inbound.eventRelay)).toEqual({
      status: "ignored",
      reason: "missing_request_id",
    });
    expect(
      pending.settleFromResponse({
        ...fixture.inbound.commandAck,
        requestId: "req-unknown",
      }),
    ).toEqual({
      status: "ignored",
      reason: "unknown_request_id",
      requestId: "req-unknown",
    });
  });

  it("keeps respond.inputRequestId separate from command requestId at type and runtime boundaries", () => {
    const pending = createPendingCommands();
    const respond = respondCommandPayload();
    const command = pending.createCommand(respond);

    expect(command.message.inputRequestId).toBe(fixture.outbound.respond.inputRequestId);
    expect(command.message.requestId).not.toBe(fixture.outbound.respond.inputRequestId);
    expect(() =>
      pending.createCommand({
        ...respond,
        requestId: respond.inputRequestId,
      } as unknown as RespondNodeCommandPayload),
    ).toThrow(
      "requestId is reserved for node command correlation; use inputRequestId",
    );
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  RunbookHandoffNotifier,
  type RunbookHandoffSubscriberQuery,
} from "../../src/runbook/runbook_handoff_notifier.js";
import type { RunbookHandoffEvent } from "../../src/runbook/runbook_service_models.js";

function createSilentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => createSilentLogger(),
  };
}

describe("RunbookHandoffNotifier", () => {
  it("sends a fire-and-forget message to each derived agent subscriber", async () => {
    const query: RunbookHandoffSubscriberQuery = {
      listAgentSubscriberSessionIds: vi.fn(async () => ["sess-agent-1", "sess-agent-2"]),
    };
    const sender = {
      send: vi.fn(async () => ({ ok: true, detail: { queued: true } })),
    };
    const logger = createSilentLogger();
    const notifier = new RunbookHandoffNotifier(query, sender as never, logger as never);

    notifier.notifyHumanHandoff(makeEvent({ status: "completed" }));
    await flushAsync();

    expect(query.listAgentSubscriberSessionIds).toHaveBeenCalledWith("rb-1");
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.send).toHaveBeenNthCalledWith(1, {
      targetSessionId: "sess-agent-1",
      message: expect.stringContaining("런북 'Launch'의 'Deploy' 완료됨, 이어서 진행"),
    });
    expect(sender.send).toHaveBeenNthCalledWith(2, {
      targetSessionId: "sess-agent-2",
      message: expect.stringContaining("item_id: item-1"),
    });
  });

  it("does not throw when delivery fails", async () => {
    const query: RunbookHandoffSubscriberQuery = {
      listAgentSubscriberSessionIds: vi.fn(async () => ["sess-agent-1"]),
    };
    const sender = {
      send: vi.fn(async () => {
        throw new Error("delivery failed");
      }),
    };
    const logger = createSilentLogger();
    const notifier = new RunbookHandoffNotifier(query, sender as never, logger as never);

    expect(() => notifier.notifyHumanHandoff(makeEvent({ status: "cancelled" }))).not.toThrow();
    await flushAsync();

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("formats runbook-level completion without item fields", async () => {
    const query: RunbookHandoffSubscriberQuery = {
      listAgentSubscriberSessionIds: vi.fn(async () => ["sess-agent-1"]),
    };
    const sender = {
      send: vi.fn(async () => ({ ok: true })),
    };
    const notifier = new RunbookHandoffNotifier(
      query,
      sender as never,
      createSilentLogger() as never,
    );

    notifier.notifyHumanHandoff(makeEvent({
      itemId: undefined,
      itemTitle: undefined,
      status: "completed",
    }));
    await flushAsync();

    expect(sender.send).toHaveBeenCalledWith({
      targetSessionId: "sess-agent-1",
      message: expect.stringContaining("런북 'Launch' 완료됨, 이어서 진행"),
    });
    expect(sender.send.mock.calls[0]?.[0].message).not.toContain("\nitem_id:");
  });
});

function makeEvent(
  overrides: Partial<RunbookHandoffEvent> = {},
): RunbookHandoffEvent {
  return {
    runbookId: "rb-1",
    runbookTitle: "Launch",
    boardItemId: "runbook:rb-1",
    itemId: "item-1",
    itemTitle: "Deploy",
    status: "completed",
    operationId: "op-1",
    eventId: 12,
    ...overrides,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

import { describe, expect, it, vi } from "vitest";

import { buildDeterministicDeliveryIdentity } from "../../src/task/delivery_identity.js";
import {
  FolderHandoffNotifier,
  type FolderHandoffSubscriberQuery,
} from "../../src/work-task/task_handoff_notifier.js";
import type { FolderHandoffEvent } from "../../src/work-task/task_service_models.js";

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

describe("FolderHandoffNotifier", () => {
  it("sends a fire-and-forget message to each derived agent subscriber", async () => {
    const query: FolderHandoffSubscriberQuery = {
      listAgentSubscriberSessionIds: vi.fn(async () => ["sess-agent-1", "sess-agent-2"]),
    };
    const sender = {
      send: vi.fn(async () => ({ ok: true, detail: { queued: true } })),
    };
    const logger = createSilentLogger();
    const notifier = new FolderHandoffNotifier(query, sender as never, logger as never);

    notifier.notifyHumanHandoff(makeEvent({ status: "completed" }));
    await flushAsync();

    expect(query.listAgentSubscriberSessionIds).toHaveBeenCalledWith("rb-1");
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.send).toHaveBeenNthCalledWith(1, {
      targetSessionId: "sess-agent-1",
      message: expect.stringContaining("업무 'Launch'의 'Deploy' 완료됨, 이어서 진행"),
      ...handoffDelivery("sess-agent-1", "op-1"),
    });
    expect(sender.send).toHaveBeenNthCalledWith(2, {
      targetSessionId: "sess-agent-2",
      message: expect.stringContaining("item_id: item-1"),
      ...handoffDelivery("sess-agent-2", "op-1"),
    });
  });

  it("does not throw when delivery fails", async () => {
    const query: FolderHandoffSubscriberQuery = {
      listAgentSubscriberSessionIds: vi.fn(async () => ["sess-agent-1"]),
    };
    const sender = {
      send: vi.fn(async () => {
        throw new Error("delivery failed");
      }),
    };
    const logger = createSilentLogger();
    const notifier = new FolderHandoffNotifier(query, sender as never, logger as never);

    expect(() => notifier.notifyHumanHandoff(makeEvent({ status: "cancelled" }))).not.toThrow();
    await flushAsync();

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

function makeEvent(
  overrides: Partial<FolderHandoffEvent> = {},
): FolderHandoffEvent {
  return {
    folderId: "rb-1",
    folderName: "Launch",
    itemId: "item-1",
    itemTitle: "Deploy",
    status: "completed",
    operationId: "op-1",
    eventId: 12,
    ...overrides,
  };
}

function handoffDelivery(targetSessionId: string, operationId: string) {
  const relationKey = `folder_checklist_handoff:rb-1:${operationId}:item-1:${targetSessionId}`;
  const identity = buildDeterministicDeliveryIdentity({
    targetSessionId,
    relationKey,
    intent: "durable_next_turn",
  });
  return {
    deliveryId: identity.deliveryId,
    deliveryIntent: "durable_next_turn" as const,
    source: "folder_checklist_handoff",
    completionId: identity.completionId,
    relationKey,
    producerTerminalRevision: "12",
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

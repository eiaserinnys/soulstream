/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTaskStreamUrl } from "./task-tree-layout";

const instances: MockEventSource[] = [];

class MockEventSource {
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  addEventListener(type: string, callback: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  close() {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }

  emitOpen() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.();
  }

  emit(type: string, data: unknown, lastEventId = "") {
    const event = {
      data: JSON.stringify(data),
      lastEventId,
    } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  emitError() {
    this.onerror?.();
  }
}

beforeEach(() => {
  instances.length = 0;
  (globalThis as unknown as { EventSource: typeof MockEventSource }).EventSource =
    MockEventSource;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const loadModule = async () => {
  vi.resetModules();
  return await import("./task-stream-subscribe");
};

describe("createTaskStreamSubscribe", () => {
  it("reconnects with the latest task stream event id and instance id", async () => {
    const { createTaskStreamSubscribe } = await loadModule();
    let lastEventId: string | undefined;
    let instanceId: string | undefined;
    const statuses: string[] = [];

    const unsubscribe = createTaskStreamSubscribe({
      reconnectDelayMs: 25,
      buildUrl: () => buildTaskStreamUrl(lastEventId, instanceId),
      onStatusChange: (status) => statuses.push(status),
      onEvent: (eventType, data, event) => {
        if (eventType === "stream_meta") {
          instanceId = typeof data.instance_id === "string" ? data.instance_id : undefined;
        }
        if (eventType === "task_changed") {
          lastEventId = event.lastEventId;
        }
      },
    });

    instances[0].emit("stream_meta", { instance_id: "orch-A", latest_id: 0 });
    instances[0].emit("task_changed", { type: "task_changed" }, "42");
    instances[0].emitError();

    expect(instances[0].closed).toBe(true);
    expect(statuses).toContain("error");

    vi.advanceTimersByTime(25);

    expect(instances).toHaveLength(2);
    expect(instances[1].url).toBe(
      "/api/tasks/stream?lastEventId=42&instanceId=orch-A",
    );

    unsubscribe();
  });

  it("clears the transient error state when a reconnect opens", async () => {
    const { createTaskStreamSubscribe } = await loadModule();
    const statuses: string[] = [];

    const unsubscribe = createTaskStreamSubscribe({
      reconnectDelayMs: 25,
      buildUrl: () => "/api/tasks/stream",
      onStatusChange: (status) => statuses.push(status),
      onEvent: vi.fn(),
    });

    instances[0].emitError();
    vi.advanceTimersByTime(25);
    instances[1].emitOpen();

    expect(statuses).toEqual([
      "connecting",
      "error",
      "connecting",
      "connected",
    ]);

    unsubscribe();
  });

  it("treats a valid task_list event as recovered even if onopen has not fired", async () => {
    const { createTaskStreamSubscribe } = await loadModule();
    const statuses: string[] = [];
    const onEvent = vi.fn();

    const unsubscribe = createTaskStreamSubscribe({
      buildUrl: () => "/api/tasks/stream",
      onStatusChange: (status) => statuses.push(status),
      onEvent,
    });

    instances[0].emit("task_list", { type: "task_list", tasks: [] });

    expect(statuses).toEqual(["connecting", "connected"]);
    expect(onEvent).toHaveBeenCalledWith(
      "task_list",
      { type: "task_list", tasks: [] },
      expect.objectContaining({ lastEventId: "" }),
    );

    unsubscribe();
  });

  it("cancels a pending reconnect on unsubscribe", async () => {
    const { createTaskStreamSubscribe } = await loadModule();
    const unsubscribe = createTaskStreamSubscribe({
      reconnectDelayMs: 25,
      buildUrl: () => "/api/tasks/stream",
      onEvent: vi.fn(),
    });

    instances[0].emitError();
    unsubscribe();
    vi.advanceTimersByTime(25);

    expect(instances).toHaveLength(1);
  });
});

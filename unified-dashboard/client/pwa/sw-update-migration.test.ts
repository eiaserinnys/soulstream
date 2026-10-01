import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

type WorkerListener = (event: Record<string, unknown>) => void;

describe("sw-update-migration", () => {
  it("activates before migrating a hidden legacy client even while navigation is pending", async () => {
    let releaseNavigation!: () => void;
    const navigation = new Promise<void>((resolve) => { releaseNavigation = resolve; });
    const harness = await createHarness({ visibilityState: "hidden", navigation });
    const activation = harness.activate();
    await harness.waitForActivationMessage();
    harness.releaseNextTimer();
    await vi.waitFor(() => expect(harness.client.navigate).toHaveBeenCalled());
    try {
      expect(harness.navigationStates).toEqual(["activated"]);
      expect(harness.worker.state).toBe("activated");
    } finally {
      releaseNavigation();
      await activation;
    }
    expect(harness.client.navigate).toHaveBeenCalledWith(harness.client.url);
  });

  it("queues an older client's immediate approval until activation completes", async () => {
    const harness = await createHarness();
    const activation = harness.activate();
    const message = await harness.waitForActivationMessage();
    await harness.sendMessage({ type: "SOULSTREAM_SW_APPROVE_RELOAD", token: message.token });
    expect(harness.client.navigate).not.toHaveBeenCalled();
    harness.releaseNextTimer();
    await activation;
    expect(harness.navigationStates).toEqual(["activated"]);
  });

  it("leaves a visible legacy client for natural navigation", async () => {
    const harness = await createHarness({ visibilityState: "visible" });
    const activation = harness.activate();
    await harness.waitForActivationMessage();
    harness.releaseNextTimer();
    await activation;

    expect(harness.client.navigate).not.toHaveBeenCalled();
  });

  it("never treats a hidden negotiation-capable client as legacy when it is frozen", async () => {
    const harness = await createHarness({ visibilityState: "hidden" });
    await harness.sendMessage({ type: "SOULSTREAM_SW_CAPABLE" });
    const activation = harness.activate();
    await harness.waitForActivationMessage();
    harness.releaseNextTimer();
    await activation;

    expect(harness.client.navigate).not.toHaveBeenCalled();
  });

  it("preserves a deferred client until it approves after flushing", async () => {
    const harness = await createHarness();
    const activation = harness.activate();
    const message = await harness.waitForActivationMessage();
    harness.sendMessage({
      type: "SOULSTREAM_SW_DEFER_RELOAD",
      token: message.token,
    });
    harness.releaseNextTimer();
    await activation;

    expect(harness.client.navigate).not.toHaveBeenCalled();
    await harness.sendMessage({
      type: "SOULSTREAM_SW_APPROVE_RELOAD",
      token: message.token,
    });
    expect(harness.client.navigate).toHaveBeenCalledWith(harness.client.url);
  });
});

async function createHarness(options: {
  visibilityState?: "hidden" | "visible";
  navigation?: Promise<void>;
} = {}) {
  const sourcePath = fileURLToPath(new URL("../../public/sw-update-migration.js", import.meta.url));
  const source = await readFile(sourcePath, "utf8");
  const listeners = new Map<string, WorkerListener>();
  const timers: Array<() => void> = [];
  const capabilityCache = new Set<string>();
  const worker = Object.assign(new EventTarget(), { state: "activating" });
  const navigationStates: string[] = [];
  let activationPromise: Promise<unknown> | undefined;
  const client = {
    id: "client-1",
    url: "https://example.test/v2",
    visibilityState: options.visibilityState ?? "visible",
    postMessage: vi.fn(),
    navigate: vi.fn(async () => { navigationStates.push(worker.state); return options.navigation; }),
  };
  const self = {
    registration: { active: worker },
    clients: { matchAll: vi.fn(async () => [client]) },
    caches: {
      open: vi.fn(async () => ({
        put: vi.fn(async (key: string) => { capabilityCache.add(key); }),
        match: vi.fn(async (key: string) => capabilityCache.has(key) ? {} : undefined),
      })),
    },
    crypto: { randomUUID: () => "migration-token" },
    setTimeout: (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
    addEventListener: (type: string, listener: WorkerListener) => listeners.set(type, listener),
  };
  vm.runInNewContext(source, { self, Set, Map, Promise, Response, encodeURIComponent });

  return {
    client, worker, navigationStates,
    activate() {
      listeners.get("activate")!({
        waitUntil(promise: Promise<unknown>) {
          activationPromise = promise;
        },
      });
      return new Promise<void>((resolve, reject) => {
        queueMicrotask(() => activationPromise!.then(() => { worker.state = "activated"; worker.dispatchEvent(new Event("statechange")); resolve(); }, reject));
      });
    },
    async waitForActivationMessage() {
      await vi.waitFor(() => expect(client.postMessage).toHaveBeenCalled());
      return client.postMessage.mock.calls[0]![0] as { token: string };
    },
    sendMessage(data: Record<string, unknown>) {
      let promise: Promise<unknown> = Promise.resolve();
      listeners.get("message")!({
        data,
        source: client,
        waitUntil(next: Promise<unknown>) { promise = next; },
      });
      return promise;
    },
    releaseNextTimer() {
      const timer = timers.shift();
      if (!timer) throw new Error("expected a pending service worker timer");
      timer();
    },
  };
}

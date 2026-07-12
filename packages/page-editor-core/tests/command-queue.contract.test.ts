import { describe, expect, it, vi } from "vitest";

import { createSerialIntentQueue } from "../src/index.js";

describe("serial editor intent queue", () => {
  it("runs FIFO and pauses until the latest projection is ready", async () => {
    let ready = true;
    const order: string[] = [];
    const queue = createSerialIntentQueue<string>({
      isReady: () => ready,
      execute: vi.fn(async (intent) => {
        order.push(intent);
        ready = false;
      }),
    });

    const first = queue.enqueue("Tab");
    const second = queue.enqueue("Shift+Tab");
    const third = queue.enqueue("paste");
    await first;
    expect(order).toEqual(["Tab"]);

    ready = true;
    queue.notifyReady();
    await second;
    expect(order).toEqual(["Tab", "Shift+Tab"]);

    ready = true;
    queue.notifyReady();
    await third;
    expect(order).toEqual(["Tab", "Shift+Tab", "paste"]);
  });

  it("suppresses exact in-flight Enter duplicates without suppressing other intents", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const executed: string[] = [];
    const queue = createSerialIntentQueue<string>({
      isReady: () => true,
      execute: async (intent) => { executed.push(intent); await gate; },
      shouldSuppress: (pending, incoming) => pending === "Enter" && incoming === "Enter",
    });

    const first = queue.enqueue("Enter");
    await Promise.resolve();
    await expect(queue.enqueue("Enter")).resolves.toBe("suppressed");
    const tab = queue.enqueue("Tab");
    release();
    await Promise.all([first, tab]);

    expect(executed).toEqual(["Enter", "Tab"]);
  });

  it("keeps the completed Enter fingerprint until its projection becomes ready", async () => {
    let ready = true;
    const executed: string[] = [];
    const queue = createSerialIntentQueue<string>({
      isReady: () => ready,
      execute: async (intent) => {
        executed.push(intent);
        ready = false;
      },
      shouldSuppress: (pending, incoming) => pending === "Enter" && incoming === "Enter",
    });

    await expect(queue.enqueue("Enter")).resolves.toBe("executed");
    await expect(queue.enqueue("Enter")).resolves.toBe("suppressed");
    ready = true;
    queue.notifyReady();
    await expect(queue.enqueue("Enter")).resolves.toBe("executed");
    expect(executed).toEqual(["Enter", "Enter"]);
  });

  it("continues with the next intent after an explicit stale failure", async () => {
    const executed: string[] = [];
    const queue = createSerialIntentQueue<string>({
      isReady: () => true,
      execute: async (intent) => {
        executed.push(intent);
        if (intent === "stale") throw new Error("stale target");
      },
    });

    await expect(queue.enqueue("stale")).rejects.toThrow("stale target");
    await expect(queue.enqueue("next")).resolves.toBe("executed");
    expect(executed).toEqual(["stale", "next"]);
  });
});

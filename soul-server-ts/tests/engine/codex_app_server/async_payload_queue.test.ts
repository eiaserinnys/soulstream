import { describe, expect, it } from "vitest";

import { AsyncPayloadQueue } from "../../../src/engine/codex_app_server/async_payload_queue.js";

async function collect<T>(queue: AsyncPayloadQueue<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of queue) {
    items.push(item);
  }
  return items;
}

describe("AsyncPayloadQueue", () => {
  it("delivers queued items in FIFO order before ending after close", async () => {
    const queue = new AsyncPayloadQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();

    queue.push("first");
    queue.push("second");
    queue.close();

    await expect(iterator.next()).resolves.toEqual({
      value: "first",
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: "second",
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it("wakes a pending next call and keeps later queued items ordered", async () => {
    const queue = new AsyncPayloadQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();

    queue.push("wakeup");
    queue.push("queued");
    queue.close();

    await expect(pending).resolves.toEqual({
      value: "wakeup",
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: "queued",
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it("resolves all pending next calls when closed", async () => {
    const queue = new AsyncPayloadQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();

    const first = iterator.next();
    const second = iterator.next();
    queue.close();

    await expect(first).resolves.toEqual({ value: undefined, done: true });
    await expect(second).resolves.toEqual({ value: undefined, done: true });
  });

  it("drops pushes after close while preserving items queued before close", async () => {
    const queue = new AsyncPayloadQueue<string>();

    queue.push("before-close");
    queue.close();
    queue.push("after-close");

    await expect(collect(queue)).resolves.toEqual(["before-close"]);
  });
});

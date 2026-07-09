import { describe, expect, it, vi } from "vitest";

import {
  InMemorySseReplayBroadcaster,
  TASK_TREE_CHANGED_CHANNEL,
  createLiveTaskChangeListener,
  type LiveDbSqlResolver,
  type LivePostgresSql,
  type TaskStreamEvent,
} from "../src/index.js";

describe("live task change listener", () => {
  it("listens to DB task_tree_changed notifications and appends task stream events", async () => {
    const captured: { notify?: (payload: string) => void } = {};
    const unlisten = vi.fn(async () => undefined);
    const sql = Object.assign(vi.fn(), {
      listen: vi.fn(async (channel: string, onnotify: (payload: string) => void) => {
        captured.notify = onnotify;
        return { unlisten };
      }),
    }) as unknown as LivePostgresSql;
    const sqlResolver = {
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(async () => undefined),
    } satisfies LiveDbSqlResolver;
    const broadcaster = new InMemorySseReplayBroadcaster<TaskStreamEvent>({
      instanceId: "task-listener-test",
    });
    const listener = createLiveTaskChangeListener({ sqlResolver, broadcaster });

    await listener.start();
    expect(listener.isRunning()).toBe(true);
    expect(sql.listen).toHaveBeenCalledWith(
      TASK_TREE_CHANGED_CHANNEL,
      expect.any(Function),
    );
    expect(captured.notify).toEqual(expect.any(Function));
    const onnotify = captured.notify;
    if (onnotify === undefined) throw new Error("listener did not register");

    onnotify(JSON.stringify({
      table: "task_items",
      action: "UPDATE",
      task_id: "task-1",
    }));
    onnotify("not-json");

    expect(broadcaster.bufferedEvents.map((event) => event.payload)).toEqual([
      {
        type: "task_changed",
        change: {
          table: "task_items",
          action: "UPDATE",
          task_id: "task-1",
        },
      },
      {
        type: "task_changed",
        change: { raw: "not-json" },
      },
    ]);

    await listener.stop();
    expect(listener.isRunning()).toBe(false);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("fails explicitly when the SQL boundary does not support LISTEN", async () => {
    const listener = createLiveTaskChangeListener({
      sqlResolver: {
        resolveSql: vi.fn(async () => vi.fn() as unknown as LivePostgresSql),
        close: vi.fn(async () => undefined),
      },
      broadcaster: new InMemorySseReplayBroadcaster<TaskStreamEvent>(),
    });

    await expect(listener.start()).rejects.toThrow(
      "Live Postgres SQL connection does not support LISTEN",
    );
    expect(listener.isRunning()).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";

import { TaskLifecycleRoute } from "../../src/task/task_lifecycle_route.js";
import { TaskLifecycleTransition } from "../../src/task/task_lifecycle_transition.js";
import type { Task } from "../../src/task/task_models.js";

import {
  DEDUPE_KEY,
  IDENTITY,
  SESSION_ID,
  makeNotifier,
  makeOutboxDirectory,
  makeStore,
  makeTask,
  silentLogger,
} from "./card1266_settlement_harness.js";

async function setup(task: Task, options: { pending?: boolean } = {}) {
  const directory = await makeOutboxDirectory();
  const store = makeStore(directory);
  const rows = new Map<string, Record<string, unknown>>();
  const harness = makeNotifier(rows);
  if (options.pending !== false) {
    store.release((await store.begin(IDENTITY)).hold);
  }
  const transition = new TaskLifecycleTransition({
    logger: silentLogger,
    completionNotifier: harness.notifier,
    settlement: store,
  } as never);
  const deleteSession = vi.fn(async () => {});
  const route = new TaskLifecycleRoute({
    getTask: () => task,
    listTasks: () => [task],
    forgetTask: vi.fn(),
    lifecycleTransition: transition,
    sessionMutations: { deleteSession } as never,
    broadcaster: { emitSessionDeleted: vi.fn(async () => {}) } as never,
    logger: silentLogger,
  });
  return { store, rows, route, deleteSession, ...harness };
}

describe("card #1266 U2b deleting a session settles its pending completion first", () => {
  it("registers the completion for an already-terminal session before the row is deleted, then leaves no entry", async () => {
    const task = makeTask();
    const subject = await setup(task);
    await expect(subject.route.deleteTask(SESSION_ID)).resolves.toBe(true);

    expect(subject.deleteSession).toHaveBeenCalledOnce();
    expect(subject.rows.size).toBe(1);
    expect(await subject.store.list()).toEqual([]);
  });

  it("registers before deleting, in that order", async () => {
    const task = makeTask();
    const subject = await setup(task);
    const order: string[] = [];
    const originalRegister = subject.repository.register.getMockImplementation()!;
    subject.repository.register.mockImplementation(async (params: Record<string, unknown>) => {
      order.push("register");
      return await originalRegister(params);
    });
    subject.deleteSession.mockImplementation(async () => { order.push("delete-session"); });

    await subject.route.deleteTask(SESSION_ID);

    expect(order).toEqual(["register", "delete-session"]);
  });

  it("does not delete the row and keeps the entry when the registration must be redone", async () => {
    const task = makeTask();
    const subject = await setup(task);
    subject.repository.register.mockRejectedValue(new Error("store unavailable"));

    await expect(subject.route.deleteTask(SESSION_ID)).rejects.toThrow("registration failed before delete");

    expect(subject.deleteSession).not.toHaveBeenCalled();
    expect(await subject.store.list()).toHaveLength(1);
  });

  it("deletes without a delivery when the policy skips the completion, and still clears the entry", async () => {
    const task = makeTask({ notifyCompletion: false });
    const subject = await setup(task);

    await subject.route.deleteTask(SESSION_ID);

    expect(subject.repository.register).not.toHaveBeenCalled();
    expect(subject.deleteSession).toHaveBeenCalledOnce();
    expect(await subject.store.list()).toEqual([]);
  });

  it("removes an entry whose terminal was never recorded, since the deleted row can no longer be restored by the sweep", async () => {
    const task = makeTask({ terminationEventRecorded: false, status: "completed" });
    const subject = await setup(task);

    await subject.route.deleteTask(SESSION_ID);

    expect(subject.repository.register).not.toHaveBeenCalled();
    expect(subject.deleteSession).toHaveBeenCalledOnce();
    expect(await subject.store.list()).toEqual([]);
  });

  it("changes nothing for a session without a pending entry", async () => {
    const task = makeTask();
    const subject = await setup(task, { pending: false });

    await subject.route.deleteTask(SESSION_ID);

    expect(subject.repository.register).not.toHaveBeenCalled();
    expect(subject.deleteSession).toHaveBeenCalledOnce();
  });
});

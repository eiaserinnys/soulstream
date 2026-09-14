import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskCreationHook } from "../../src/task/task_creation_hook.js";
import { makeTaskCreationHarness as makeHarness } from "./task_creation_harness.js";

describe("TaskCreation durable ACK boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns after durable prerequisites while tracking slow projections in order", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const hook: TaskCreationHook = {
      persistCreationIntent: vi.fn(async () => {
        order.push("binding-intent");
      }),
      afterSessionRegistered: vi.fn(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 5_001));
        order.push("page-binding");
      }),
      afterLegacyProjection: vi.fn(async () => {
        order.push("legacy-projection");
      }),
    };
    const h = makeHarness({ taskCreationHook: hook });
    h.registerSession.mockImplementation(async () => {
      order.push("register");
    });
    h.appendMetadata.mockImplementation(async () => {
      order.push("metadata");
      return 1;
    });
    h.upsertSessionBoardItem.mockImplementation(async () => {
      order.push("folder");
      return {} as never;
    });
    h.emitCatalogUpdated.mockImplementation(async () => {
      order.push("catalog");
    });
    h.emitSessionCreated.mockImplementation(async () => {
      order.push("session-created");
    });

    const task = await h.creation.createTask({
      agentSessionId: "sess-durable-ack",
      prompt: "start without waiting for projection",
      profileId: "codex-default",
      callerInfo: { source: "execute-proxy" },
      folderId: "folder-1",
    });

    expect(h.tasks.get(task.agentSessionId)).toBe(task);
    expect(order).toEqual(["register", "metadata", "binding-intent"]);
    expect(h.upsertSessionBoardItem).not.toHaveBeenCalled();
    expect(h.emitSessionCreated).not.toHaveBeenCalled();
    await expect(h.creation.createTask({
      agentSessionId: "sess-durable-ack",
      prompt: "duplicate",
    })).rejects.toThrow("Task already exists: sess-durable-ack");

    await vi.advanceTimersByTimeAsync(5_001);
    await h.creation.waitForDeferredEffects(task.agentSessionId);

    expect(order).toEqual([
      "register",
      "metadata",
      "binding-intent",
      "page-binding",
      "folder",
      "catalog",
      "legacy-projection",
      "session-created",
    ]);
  });

  it("surfaces a deferred binding failure and still completes catalog then session_created", async () => {
    const bindingError = new Error("page host unavailable");
    const hook: TaskCreationHook = {
      persistCreationIntent: vi.fn(async () => undefined),
      afterSessionRegistered: vi.fn(async () => {
        throw bindingError;
      }),
    };
    const h = makeHarness({ taskCreationHook: hook });

    const task = await h.creation.createTask({
      agentSessionId: "sess-binding-warning",
      prompt: "warning remains observable",
      folderId: "folder-1",
    });
    await h.creation.waitForDeferredEffects(task.agentSessionId);

    expect(task.creationWarnings).toEqual([{
      code: "PAGE_BINDING_PENDING",
      message: "The session was created, but page binding status could not be confirmed. Check the page before retrying.",
    }]);
    expect(h.emitCatalogUpdated.mock.invocationCallOrder[0]).toBeLessThan(
      h.emitSessionCreated.mock.invocationCallOrder[0],
    );
    expect(h.emitSessionCreated).toHaveBeenCalledWith(task, "folder-1");
  });

  it("does not remember or start deferred effects when registration or metadata fails", async () => {
    const hook: TaskCreationHook = {
      persistCreationIntent: vi.fn(async () => undefined),
      afterSessionRegistered: vi.fn(async () => undefined),
    };
    const registration = makeHarness({ taskCreationHook: hook });
    registration.registerSession.mockRejectedValueOnce(new Error("register failed"));

    await expect(registration.creation.createTask({
      agentSessionId: "sess-register-failed",
      prompt: "fail",
    })).rejects.toThrow("register failed");
    expect(registration.tasks.has("sess-register-failed")).toBe(false);
    expect(hook.persistCreationIntent).not.toHaveBeenCalled();
    expect(hook.afterSessionRegistered).not.toHaveBeenCalled();
    const registrationRetry = await registration.creation.createTask({
      agentSessionId: "sess-register-failed",
      prompt: "retry",
    });
    expect(registration.registerSession.mock.calls.map((call) => call[1])).toEqual([
      "register_session:sess-register-failed",
      "register_session:sess-register-failed",
    ]);
    await registration.creation.waitForDeferredEffects(registrationRetry.agentSessionId);

    const metadataHook: TaskCreationHook = {
      persistCreationIntent: vi.fn(async () => undefined),
      afterSessionRegistered: vi.fn(async () => undefined),
    };
    const metadata = makeHarness({ taskCreationHook: metadataHook });
    metadata.appendMetadata.mockRejectedValueOnce(new Error("metadata failed"));

    await expect(metadata.creation.createTask({
      agentSessionId: "sess-metadata-failed",
      prompt: "fail",
      callerInfo: { source: "browser" },
    })).rejects.toThrow("metadata failed");
    expect(metadata.tasks.has("sess-metadata-failed")).toBe(false);
    expect(metadataHook.persistCreationIntent).not.toHaveBeenCalled();
    expect(metadataHook.afterSessionRegistered).not.toHaveBeenCalled();
    const metadataRetry = await metadata.creation.createTask({
      agentSessionId: "sess-metadata-failed",
      prompt: "retry",
      callerInfo: { source: "browser" },
    });
    expect(metadata.registerSession.mock.calls.map((call) => call[1])).toEqual([
      "register_session:sess-metadata-failed",
      "register_session:sess-metadata-failed",
    ]);
    await metadata.creation.waitForDeferredEffects(metadataRetry.agentSessionId);
  });

  it("rejects a concurrent duplicate before a second registration can start", async () => {
    let finishRegistration!: () => void;
    const h = makeHarness();
    h.registerSession.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishRegistration = resolve;
      });
    });

    const first = h.creation.createTask({
      agentSessionId: "sess-concurrent-duplicate",
      prompt: "first",
    });
    await vi.waitFor(() => expect(h.registerSession).toHaveBeenCalledOnce());
    await expect(h.creation.createTask({
      agentSessionId: "sess-concurrent-duplicate",
      prompt: "second",
    })).rejects.toThrow("Task already exists: sess-concurrent-duplicate");
    expect(h.registerSession).toHaveBeenCalledOnce();

    finishRegistration();
    const task = await first;
    expect(h.tasks.get(task.agentSessionId)).toBe(task);
    await h.creation.waitForDeferredEffects(task.agentSessionId);
  });

  it("bounds shutdown draining when a deferred projection is stuck", async () => {
    vi.useFakeTimers();
    const h = makeHarness({
      taskCreationHook: {
        persistCreationIntent: vi.fn(async () => undefined),
        afterSessionRegistered: vi.fn(async () => {
          await new Promise<void>(() => undefined);
        }),
      },
    });
    await h.creation.createTask({
      agentSessionId: "sess-stuck-projection",
      prompt: "stuck",
    });

    const draining = h.creation.drainDeferredEffects(250);
    await vi.advanceTimersByTimeAsync(250);
    await expect(draining).resolves.toBe(false);
  });
});

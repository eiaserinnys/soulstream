import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import {
  AppServerRpcError,
  CodexAppServerEngineAdapter,
  type CodexAppServerClientPort,
} from "../../../src/engine/codex_app_server/index.js";
import type {
  AppServerNotification,
  AppServerTurn,
  InitializeParams,
  InitializeResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from "../../../src/engine/codex_app_server/protocol.js";
import type { SSEEventPayload } from "../../../src/engine/protocol.js";

class FakeClient implements CodexAppServerClientPort {
  public readonly initialize = vi.fn(
    async (_params: InitializeParams): Promise<InitializeResponse> => ({
      userAgent: "codex-cli/0.133.0",
      codexHome: "/home/eias/.codex",
      platformFamily: "unix",
      platformOs: "linux",
    }),
  );
  public readonly startThread = vi.fn(
    async (_params: ThreadStartParams): Promise<ThreadStartResponse> =>
      threadResponse("thread-1"),
  );
  public readonly resumeThread = vi.fn(
    async (_params: ThreadResumeParams): Promise<ThreadResumeResponse> =>
      threadResponse("thread-existing"),
  );
  public readonly startTurn = vi.fn(
    async (_params: TurnStartParams): Promise<TurnStartResponse> => ({
      turn: turn("turn-1"),
    }),
  );
  public readonly steerTurn = vi.fn(
    async (_params: TurnSteerParams): Promise<TurnSteerResponse> => ({
      turnId: "turn-1",
    }),
  );
  public readonly interruptTurn = vi.fn(
    async (_params: TurnInterruptParams): Promise<TurnInterruptResponse> => ({}),
  );
  public readonly close = vi.fn(async () => {});

  private notificationHandlers = new Set<(notification: AppServerNotification) => void>();
  private errorHandlers = new Set<(error: Error) => void>();
  private closeHandlers = new Set<(error?: Error) => void>();

  onNotification(handler: (notification: AppServerNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onClose(handler: (error?: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  emit(notification: AppServerNotification): void {
    for (const handler of this.notificationHandlers) handler(notification);
  }

  fail(error: Error): void {
    for (const handler of this.errorHandlers) handler(error);
  }

  closeWith(error?: Error): void {
    for (const handler of this.closeHandlers) handler(error);
  }
}

function turn(
  id: string,
  status: AppServerTurn["status"] = "inProgress",
): AppServerTurn {
  return {
    id,
    items: [],
    itemsView: { kind: "full" },
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1000,
  };
}

function threadResponse(threadId: string): ThreadStartResponse {
  return {
    thread: { id: threadId },
    model: "gpt-5.5",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/work",
    runtimeWorkspaceRoots: ["/work"],
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "client",
    sandbox: { mode: "danger-full-access" },
    activePermissionProfile: null,
    reasoningEffort: "xhigh",
  };
}

function makeAdapter(client = new FakeClient()) {
  const adapter = new CodexAppServerEngineAdapter(
    {
      workspaceDir: "/work",
      client,
    },
    pino({ level: "silent" }),
  );
  return { adapter, client };
}

async function drain(
  iterable: AsyncIterable<SSEEventPayload>,
): Promise<SSEEventPayload[]> {
  const out: SSEEventPayload[] = [];
  for await (const event of iterable) {
    out.push(event);
  }
  return out;
}

describe("CodexAppServerEngineAdapter", () => {
  it("starts thread and turn, yields mapped events, and stores active turn for live steer", async () => {
    const { adapter, client } = makeAdapter();
    const eventsPromise = drain(adapter.execute({ prompt: "hello", model: "gpt-5.5" }));

    await vi.waitFor(() => expect(client.startTurn).toHaveBeenCalledTimes(1));
    expect(client.initialize).toHaveBeenCalledWith({
      clientInfo: { name: "soul-server-ts", version: "0.0.1" },
      capabilities: { experimentalApi: true },
    });
    expect(client.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/work",
        runtimeWorkspaceRoots: ["/work"],
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        sessionStartSource: "startup",
        threadSource: "user",
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      }),
    );
    expect(client.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        input: [{ type: "text", text: "hello", text_elements: [] }],
        model: "gpt-5.5",
        cwd: "/work",
        runtimeWorkspaceRoots: ["/work"],
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      }),
    );

    await expect(
      adapter.steerActiveTurn({ prompt: "steer now" }),
    ).resolves.toEqual({ status: "delivered" });
    expect(client.steerTurn).toHaveBeenCalledWith({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "steer now", text_elements: [] }],
    });

    client.emit({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 1000,
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "",
          phase: null,
          memoryCitation: null,
        },
      },
    });
    client.emit({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "answer",
      },
    });
    client.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 2000,
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "answer",
          phase: null,
          memoryCitation: null,
        },
      },
    });
    client.emit({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: turn("turn-1", "completed") },
    });

    const events = await eventsPromise;
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "session",
      "text_start",
      "text_delta",
      "assistant_message",
      "text_end",
      "complete",
    ]);
    expect(events[3]).toMatchObject({
      type: "assistant_message",
      content: "answer",
      _final_for_live_stream: true,
    });
    await expect(adapter.steerActiveTurn({ prompt: "late" })).resolves.toEqual({
      status: "no_active_turn",
      message: "No active Codex app-server turn",
    });
  });

  it("resumes existing thread without emitting a duplicate session event", async () => {
    const { adapter, client } = makeAdapter();
    const eventsPromise = drain(
      adapter.execute({ prompt: "resume", resumeSessionId: "thread-existing" }),
    );

    await vi.waitFor(() => expect(client.startTurn).toHaveBeenCalledTimes(1));
    expect(client.startThread).not.toHaveBeenCalled();
    expect(client.resumeThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-existing",
        cwd: "/work",
        runtimeWorkspaceRoots: ["/work"],
        persistExtendedHistory: false,
      }),
    );
    client.emit({
      method: "turn/completed",
      params: { threadId: "thread-existing", turn: turn("turn-1", "completed") },
    });

    const events = await eventsPromise;
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "complete",
    ]);
  });

  it("steer returns no_active_turn before execute and failed on RPC error", async () => {
    const client = new FakeClient();
    client.steerTurn.mockRejectedValueOnce(
      new AppServerRpcError("transport closed", {
        code: -32000,
        requestId: "req-1",
      }),
    );
    const { adapter } = makeAdapter(client);

    await expect(adapter.steerActiveTurn({ prompt: "before" })).resolves.toEqual({
      status: "no_active_turn",
      message: "No active Codex app-server turn",
    });

    const eventsPromise = drain(adapter.execute({ prompt: "hello" }));
    await vi.waitFor(() => expect(client.startTurn).toHaveBeenCalledTimes(1));
    await expect(adapter.steerActiveTurn({ prompt: "during" })).resolves.toEqual({
      status: "failed",
      message: "transport closed",
    });
    client.emit({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: turn("turn-1", "completed") },
    });
    await eventsPromise;
  });

  it("interrupt delegates to app-server turn/interrupt only when a turn is active", async () => {
    const { adapter, client } = makeAdapter();
    await expect(adapter.interrupt()).resolves.toBe(false);

    const eventsPromise = drain(adapter.execute({ prompt: "hello" }));
    await vi.waitFor(() => expect(client.startTurn).toHaveBeenCalledTimes(1));

    await expect(adapter.interrupt()).resolves.toBe(true);
    expect(client.interruptTurn).toHaveBeenCalledWith({
      threadId: "thread-1",
      turnId: "turn-1",
    });

    client.emit({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: turn("turn-1", "interrupted") },
    });
    await eventsPromise;
  });

  it("transport close during execute yields fatal error and close() is idempotent", async () => {
    const { adapter, client } = makeAdapter();
    const eventsPromise = drain(adapter.execute({ prompt: "hello" }));
    await vi.waitFor(() => expect(client.startTurn).toHaveBeenCalledTimes(1));

    client.closeWith(new Error("process exited"));

    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: "process exited",
      fatal: true,
    });

    await adapter.close();
    await adapter.close();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("adapter close during execute ends the active queue without adding a fatal error", async () => {
    const { adapter, client } = makeAdapter();
    const eventsPromise = drain(adapter.execute({ prompt: "hello" }));
    await vi.waitFor(() => expect(client.startTurn).toHaveBeenCalledTimes(1));

    await adapter.close();

    const events = await eventsPromise;
    expect(events.map((event) => (event as { type: string }).type)).toEqual(["session"]);
    expect(events.some((event) => (event as { type: string }).type === "error")).toBe(false);
    expect(client.close).toHaveBeenCalledTimes(1);
    await expect(adapter.steerActiveTurn({ prompt: "late" })).resolves.toEqual({
      status: "no_active_turn",
      message: "No active Codex app-server turn",
    });
  });
});

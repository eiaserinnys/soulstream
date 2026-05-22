import { describe, expect, it, vi } from "vitest";

import {
  AppServerRpcError,
  CodexAppServerClient,
} from "../../../src/engine/codex_app_server/client.js";
import type {
  AppServerJsonMessage,
  AppServerTransport,
} from "../../../src/engine/codex_app_server/transport.js";
import type {
  AppServerNotification,
  AppServerServerRequest,
  AppServerTurn,
} from "../../../src/engine/codex_app_server/protocol.js";

class FakeTransport implements AppServerTransport {
  public readonly sent: AppServerJsonMessage[] = [];
  private messageHandlers = new Set<(message: AppServerJsonMessage) => void>();
  private errorHandlers = new Set<(error: Error) => void>();
  private closeHandlers = new Set<(error?: Error) => void>();

  async send(message: AppServerJsonMessage): Promise<void> {
    this.sent.push(message);
  }

  onMessage(handler: (message: AppServerJsonMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onClose(handler: (error?: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async close(): Promise<void> {
    for (const handler of this.closeHandlers) handler();
  }

  receive(message: AppServerJsonMessage): void {
    for (const handler of this.messageHandlers) handler(message);
  }

  fail(error: Error): void {
    for (const handler of this.errorHandlers) handler(error);
  }

  closeWith(error?: Error): void {
    for (const handler of this.closeHandlers) handler(error);
  }
}

function createClient(transport = new FakeTransport()) {
  let nextId = 0;
  const client = new CodexAppServerClient(transport, {
    requestTimeoutMs: 50,
    idFactory: () => `req-${++nextId}`,
  });
  return { client, transport };
}

function turn(id: string): AppServerTurn {
  return {
    id,
    items: [],
    itemsView: { kind: "full" },
    status: "running",
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
  };
}

describe("CodexAppServerClient typed methods", () => {
  it("initialize sends typed request and resolves correlated response", async () => {
    const { client, transport } = createClient();
    const resultPromise = client.initialize({
      clientInfo: { name: "soul-server-ts", version: "0.0.1" },
      capabilities: null,
    });

    expect(transport.sent).toEqual([
      {
        id: "req-1",
        method: "initialize",
        params: {
          clientInfo: { name: "soul-server-ts", version: "0.0.1" },
          capabilities: null,
        },
      },
    ]);

    transport.receive({
      id: "req-1",
      result: {
        userAgent: "codex-cli/0.133.0",
        codexHome: "/home/eias/.codex",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });

    await expect(resultPromise).resolves.toMatchObject({
      userAgent: "codex-cli/0.133.0",
      platformOs: "linux",
    });
    expect(client.pendingRequestCount).toBe(0);
  });

  it("thread and turn methods keep generated method shapes", async () => {
    const { client, transport } = createClient();

    const startThread = client.startThread({
      cwd: "/work",
      runtimeWorkspaceRoots: ["/work"],
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
    expect(transport.sent[0]).toMatchObject({
      id: "req-1",
      method: "thread/start",
      params: {
        cwd: "/work",
        runtimeWorkspaceRoots: ["/work"],
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      },
    });
    transport.receive({
      id: "req-1",
      result: {
        thread: { id: "thread-1" },
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
      },
    });
    await expect(startThread).resolves.toMatchObject({
      thread: { id: "thread-1" },
    });

    const resume = client.resumeThread({
      threadId: "thread-1",
      persistExtendedHistory: false,
    });
    expect(transport.sent[1]).toMatchObject({
      id: "req-2",
      method: "thread/resume",
      params: { threadId: "thread-1", persistExtendedHistory: false },
    });
    transport.receive({
      id: "req-2",
      result: {
        thread: { id: "thread-1" },
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
      },
    });
    await expect(resume).resolves.toMatchObject({
      thread: { id: "thread-1" },
    });

    const startTurn = client.startTurn({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello", text_elements: [] }],
    });
    expect(transport.sent[2]).toEqual({
      id: "req-3",
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "hello", text_elements: [] }],
      },
    });
    transport.receive({ id: "req-3", result: { turn: turn("turn-1") } });
    await expect(startTurn).resolves.toMatchObject({
      turn: { id: "turn-1" },
    });

    const steer = client.steerTurn({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "more", text_elements: [] }],
    });
    expect(transport.sent[3]).toEqual({
      id: "req-4",
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "more", text_elements: [] }],
      },
    });
    transport.receive({ id: "req-4", result: { turnId: "turn-1" } });
    await expect(steer).resolves.toEqual({ turnId: "turn-1" });

    const interrupt = client.interruptTurn({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(transport.sent[4]).toEqual({
      id: "req-5",
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    transport.receive({ id: "req-5", result: {} });
    await expect(interrupt).resolves.toEqual({});
  });
});

describe("CodexAppServerClient inbound dispatch", () => {
  it("dispatches notifications and server-initiated requests", () => {
    const { client, transport } = createClient();
    const notifications: AppServerNotification[] = [];
    const serverRequests: AppServerServerRequest[] = [];

    client.onNotification((notification) => notifications.push(notification));
    client.onServerRequest((request) => serverRequests.push(request));

    transport.receive({
      method: "turn/started",
      params: { threadId: "thread-1", turn: turn("turn-1") },
    });
    transport.receive({
      id: "srv-1",
      method: "item/tool/requestUserInput",
      params: { prompt: "continue?" },
    });

    expect(notifications).toEqual([
      {
        method: "turn/started",
        params: { threadId: "thread-1", turn: turn("turn-1") },
      },
    ]);
    expect(serverRequests).toEqual([
      {
        id: "srv-1",
        method: "item/tool/requestUserInput",
        params: { prompt: "continue?" },
      },
    ]);
  });

  it("forwards transport parse errors to error subscribers", () => {
    const { client, transport } = createClient();
    const errors: string[] = [];
    client.onError((error) => errors.push(error.message));

    transport.fail(new Error("malformed json"));

    expect(errors).toEqual(["malformed json"]);
  });
});

describe("CodexAppServerClient cleanup", () => {
  it("rejects JSON-RPC errors and removes pending request", async () => {
    const { client, transport } = createClient();
    const resultPromise = client.startTurn({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello", text_elements: [] }],
    });

    transport.receive({
      id: "req-1",
      error: { code: -32000, message: "turn mismatch" },
    });

    await expect(resultPromise).rejects.toBeInstanceOf(AppServerRpcError);
    await expect(resultPromise).rejects.toMatchObject({
      code: -32000,
      message: "turn mismatch",
    });
    expect(client.pendingRequestCount).toBe(0);
  });

  it("times out pending requests, cleans them up, and ignores late responses", async () => {
    vi.useFakeTimers();
    try {
      const { client, transport } = createClient();
      const resultPromise = client.startTurn({
        threadId: "thread-1",
        input: [{ type: "text", text: "hello", text_elements: [] }],
      });
      const rejection = expect(resultPromise).rejects.toThrow(
        "Codex app-server request timed out",
      );
      expect(client.pendingRequestCount).toBe(1);

      await vi.advanceTimersByTimeAsync(51);

      await rejection;
      expect(client.pendingRequestCount).toBe(0);

      transport.receive({
        id: "req-1",
        result: { turn: turn("turn-1") },
      });
      expect(client.pendingRequestCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects all pending requests when transport closes", async () => {
    const { client, transport } = createClient();
    const resultPromise = client.startTurn({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello", text_elements: [] }],
    });

    transport.closeWith(new Error("process exited"));

    await expect(resultPromise).rejects.toThrow("process exited");
    expect(client.pendingRequestCount).toBe(0);
  });
});

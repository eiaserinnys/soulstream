import { describe, expect, it, vi } from "vitest";

import {
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
} from "../src/node/pending_commands.js";
import { createRecurringSession } from "../src/session/recurring_session_creation.js";
import {
  NodeCommandTransportError,
  type SessionCommandTransportBridge,
} from "../src/session/session_command_transport.js";
import type { SessionCommandRouter } from "../src/session/session_command_router.js";

const sessionId = "81d61f13-b99b-4c58-9830-55487618e4dc";

describe("recurring session creation", () => {
  it("rejects an invalid persisted session ID before it can create a node command", async () => {
    const createSession = vi.fn();

    await expect(createRecurringSession({
      router: { createSession } as unknown as SessionCommandRouter,
      bridge: {} as SessionCommandTransportBridge,
    }, {
      ...input(),
      sessionId: "not-a-stable-session-id",
    })).rejects.toMatchObject({
      code: "INVALID_STABLE_SESSION_ID",
      dispatchPhase: "before_send",
    });

    expect(createSession).not.toHaveBeenCalled();
  });

  it("rechecks only the persisted ID after a sent command times out", async () => {
    const routed = {
      node: { nodeId: "node-a" },
      command: { requestId: "request-1" },
      modelPresetId: "preset-a",
    };
    const createSession = vi.fn(() => routed);
    const waitForCreatedSession = vi.fn(async () => false);
    const sendPendingCommand = vi.fn(async () => {
      throw new PendingNodeCommandTimeoutError({
        commandType: "create_session",
        requestId: "request-1",
        timeoutMs: 1_000,
      });
    });

    await expect(createRecurringSession({
      router: { createSession, waitForCreatedSession } as unknown as SessionCommandRouter,
      bridge: { sendPendingCommand } as unknown as SessionCommandTransportBridge,
      reconcileTimeoutMs: 0,
    }, input())).resolves.toEqual({
      state: "awaiting_session",
      resolvedModelPreset: "preset-a",
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      type: "create_session",
      agentSessionId: sessionId,
      nodeId: "node-a",
      profile: "roselin",
    }), expect.any(Object));
    expect(sendPendingCommand).toHaveBeenCalledWith(routed);
    expect(waitForCreatedSession).toHaveBeenCalledWith(sessionId, "node-a", { timeoutMs: 0 });
  });

  it("keeps an ACK with a different session ID on the persisted ID for reconciliation", async () => {
    const routed = {
      node: { nodeId: "node-a" },
      command: { requestId: "request-1" },
      modelPresetId: "preset-a",
    };
    const createSession = vi.fn(() => routed);
    const sendPendingCommand = vi.fn(async () => ({
      type: "session_created",
      agentSessionId: "93b580f9-6e7a-4f63-a16e-1e8cec431a50",
    }));

    const waitForCreatedSession = vi.fn(async () => false);

    await expect(createRecurringSession({
      router: {
        createSession,
        waitForCreatedSession,
      } as unknown as SessionCommandRouter,
      bridge: { sendPendingCommand } as unknown as SessionCommandTransportBridge,
      reconcileTimeoutMs: 0,
    }, input())).resolves.toEqual({
      state: "awaiting_session",
      resolvedModelPreset: "preset-a",
    });
    expect(sendPendingCommand).toHaveBeenCalledTimes(1);
    expect(waitForCreatedSession).toHaveBeenCalledWith(sessionId, "node-a", { timeoutMs: 0 });
  });

  it("keeps a disconnect during ACK wait on the fixed session ID", async () => {
    const routed = {
      node: { nodeId: "node-a" },
      command: { requestId: "request-1" },
      modelPresetId: "preset-a",
    };
    const waitForCreatedSession = vi.fn(async () => false);
    const sendPendingCommand = vi.fn(async () => {
      throw new PendingNodeCommandRejectedError({
        commandType: "create_session",
        requestId: "request-1",
        message: "Node disconnected while waiting for ACK.",
      });
    });

    await expect(createRecurringSession({
      router: {
        createSession: vi.fn(() => routed),
        waitForCreatedSession,
      } as unknown as SessionCommandRouter,
      bridge: { sendPendingCommand } as unknown as SessionCommandTransportBridge,
      reconcileTimeoutMs: 0,
    }, input())).resolves.toEqual({
      state: "awaiting_session",
      resolvedModelPreset: "preset-a",
    });
    expect(waitForCreatedSession).toHaveBeenCalledWith(sessionId, "node-a", { timeoutMs: 0 });
  });

  it("keeps a transport send failure on the fixed session ID", async () => {
    const routed = {
      node: { nodeId: "node-a", connectionId: "connection-a" },
      command: { requestId: "request-1" },
      modelPresetId: "preset-a",
    };
    const waitForCreatedSession = vi.fn(async () => false);
    const sendPendingCommand = vi.fn(async () => {
      throw new NodeCommandTransportError({
        code: "TRANSPORT_SEND_FAILED",
        nodeId: "node-a",
        connectionId: "connection-a",
        message: "socket closed after send began",
      });
    });

    await expect(createRecurringSession({
      router: {
        createSession: vi.fn(() => routed),
        waitForCreatedSession,
      } as unknown as SessionCommandRouter,
      bridge: { sendPendingCommand } as unknown as SessionCommandTransportBridge,
      reconcileTimeoutMs: 0,
    }, input())).resolves.toEqual({
      state: "awaiting_session",
      resolvedModelPreset: "preset-a",
    });
    expect(waitForCreatedSession).toHaveBeenCalledWith(sessionId, "node-a", { timeoutMs: 0 });
  });

  it("keeps a confirmed node rejection terminal", async () => {
    const routed = {
      node: { nodeId: "node-a" },
      command: { requestId: "request-1" },
      modelPresetId: "preset-a",
    };
    const sendPendingCommand = vi.fn(async () => {
      throw new PendingNodeCommandRejectedError({
        commandType: "create_session",
        requestId: "request-1",
        message: "Node rejected create_session.",
        response: { type: "error", message: "Node rejected create_session." },
      });
    });

    await expect(createRecurringSession({
      router: { createSession: vi.fn(() => routed) } as unknown as SessionCommandRouter,
      bridge: { sendPendingCommand } as unknown as SessionCommandTransportBridge,
    }, input())).rejects.toMatchObject({
      code: "NODE_REJECTED",
      dispatchPhase: "after_send",
    });
  });

  it("keeps a definitely pre-send transport failure terminal", async () => {
    const routed = {
      node: { nodeId: "node-a", connectionId: "connection-a" },
      command: { requestId: "request-1" },
      modelPresetId: "preset-a",
    };
    const sendPendingCommand = vi.fn(async () => {
      throw new NodeCommandTransportError({
        code: "TRANSPORT_MISSING",
        nodeId: "node-a",
        connectionId: "connection-a",
        message: "transport was absent before any send",
      });
    });

    await expect(createRecurringSession({
      router: { createSession: vi.fn(() => routed) } as unknown as SessionCommandRouter,
      bridge: { sendPendingCommand } as unknown as SessionCommandTransportBridge,
    }, input())).rejects.toMatchObject({ code: "TRANSPORT_MISSING" });
  });
});

function input() {
  return {
    sessionId,
    prompt: "Run the durable recurring job.",
    nodeId: "node-a",
    agentId: "roselin",
    modelPreset: "preset-a",
    folderId: "folder-a",
    container: { kind: "folder" as const, id: "folder-a" },
    callerInfo: { source: "scheduler" },
  };
}

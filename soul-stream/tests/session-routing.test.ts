/**
 * SessionRouter 단위 테스트.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { NodeManager } from "../src/nodes/node-manager";
import { SessionRouter } from "../src/sessions/session-router";
import type { NodeRegistration } from "../src/nodes/types";

function createMockWs() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    readyState: 1,
    OPEN: 1,
    send: vi.fn(),
    close: vi.fn(),
  }) as unknown as import("ws").WebSocket;
}

function autoReplySessionCreated(ws: ReturnType<typeof createMockWs>) {
  (ws.send as ReturnType<typeof vi.fn>).mockImplementation((data: string) => {
    const msg = JSON.parse(data);
    if (msg.type === "create_session") {
      setTimeout(() => {
        (ws as unknown as EventEmitter).emit(
          "message",
          JSON.stringify({
            type: "session_created",
            session_id: `session-${Date.now()}`,
            request_id: msg.request_id,
          })
        );
      }, 0);
    }
  });
}

const REG_ALPHA: NodeRegistration = {
  type: "node_register",
  node_id: "alpha",
  host: "localhost",
  port: 3105,
  capabilities: { max_concurrent: 3 },
};

const REG_BETA: NodeRegistration = {
  type: "node_register",
  node_id: "beta",
  host: "localhost",
  port: 3106,
  capabilities: { max_concurrent: 2 },
};

describe("SessionRouter", () => {
  let manager: NodeManager;
  let router: SessionRouter;

  beforeEach(() => {
    manager = new NodeManager();
    router = new SessionRouter(manager);
  });

  it("routes to specified nodeId", async () => {
    const ws = createMockWs();
    autoReplySessionCreated(ws);
    manager.registerNode(ws, REG_ALPHA);

    const result = await router.createSession({
      prompt: "Hello",
      nodeId: "alpha",
    });

    expect(result.nodeId).toBe("alpha");
    expect(result.sessionId).toBeDefined();
  });

  it("throws if specified node not found", async () => {
    await expect(
      router.createSession({ prompt: "Hello", nodeId: "nonexistent" })
    ).rejects.toThrow("Node not found");
  });

  it("throws if specified node is disconnected", async () => {
    const ws = createMockWs();
    manager.registerNode(ws, REG_ALPHA);
    (ws as unknown as EventEmitter).emit("close");

    await expect(
      router.createSession({ prompt: "Hello", nodeId: "alpha" })
    ).rejects.toThrow("disconnected");
  });

  it("throws if no connected nodes available", async () => {
    await expect(router.createSession({ prompt: "Hello" })).rejects.toThrow(
      "No connected nodes"
    );
  });

  it("auto-routes to node with fewest sessions", async () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    autoReplySessionCreated(ws1);
    autoReplySessionCreated(ws2);

    manager.registerNode(ws1, REG_ALPHA);
    manager.registerNode(ws2, REG_BETA);

    // alpha에 2개 세션 생성
    await router.createSession({ prompt: "1", nodeId: "alpha" });
    await router.createSession({ prompt: "2", nodeId: "alpha" });

    // auto-route는 beta (세션 0개)를 선택해야 함
    const result = await router.createSession({ prompt: "3" });
    expect(result.nodeId).toBe("beta");
  });
});

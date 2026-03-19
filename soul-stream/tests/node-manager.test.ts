/**
 * NodeManager + NodeConnection 단위 테스트.
 *
 * 실제 WebSocket 대신 EventEmitter로 모킹한다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { NodeManager } from "../src/nodes/node-manager";
import { NodeConnection } from "../src/nodes/node-connection";
import type { NodeRegistration, NodeChangeEvent } from "../src/nodes/types";

/** WebSocket mock — EventEmitter + readyState + send + close */
function createMockWs() {
  const emitter = new EventEmitter();
  const ws = Object.assign(emitter, {
    readyState: 1,
    OPEN: 1,
    send: vi.fn(),
    close: vi.fn(),
  });
  return ws as unknown as import("ws").WebSocket;
}

const REG: NodeRegistration = {
  type: "node_register",
  node_id: "alpha",
  host: "localhost",
  port: 3105,
  capabilities: { max_concurrent: 3 },
};

describe("NodeManager", () => {
  let manager: NodeManager;

  beforeEach(() => {
    manager = new NodeManager();
  });

  it("registers a node and emits event", () => {
    const events: NodeChangeEvent[] = [];
    manager.onNodeChange((e) => events.push(e));

    const ws = createMockWs();
    const conn = manager.registerNode(ws, REG);

    expect(conn.nodeId).toBe("alpha");
    expect(manager.size).toBe(1);
    expect(manager.getNodes()).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("node_registered");
    expect(events[0].nodeId).toBe("alpha");
  });

  it("replaces existing node on re-register", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    manager.registerNode(ws1, REG);
    manager.registerNode(ws2, REG);

    expect(manager.size).toBe(1);
    expect(ws1.close).toHaveBeenCalled();
  });

  it("unregisters a node and emits event", () => {
    const events: NodeChangeEvent[] = [];
    manager.onNodeChange((e) => events.push(e));

    const ws = createMockWs();
    manager.registerNode(ws, REG);
    manager.unregisterNode("alpha");

    expect(manager.size).toBe(0);
    const unregEvent = events.find((e) => e.type === "node_unregistered");
    expect(unregEvent).toBeDefined();
  });

  it("returns undefined for unknown node", () => {
    expect(manager.getNode("nonexistent")).toBeUndefined();
  });

  it("listener unsubscribe works", () => {
    const events: NodeChangeEvent[] = [];
    const unsub = manager.onNodeChange((e) => events.push(e));

    const ws1 = createMockWs();
    manager.registerNode(ws1, REG);
    expect(events).toHaveLength(1);

    unsub();

    const ws2 = createMockWs();
    manager.registerNode(ws2, { ...REG, node_id: "beta" });
    expect(events).toHaveLength(1); // 추가 이벤트 없음
  });

  it("emits node_status_changed when ws closes", () => {
    const events: NodeChangeEvent[] = [];
    manager.onNodeChange((e) => events.push(e));

    const ws = createMockWs();
    manager.registerNode(ws, REG);

    // WebSocket close 시뮬레이션
    (ws as unknown as EventEmitter).emit("close");

    const statusEvent = events.find((e) => e.type === "node_status_changed");
    expect(statusEvent).toBeDefined();
    expect(statusEvent?.node?.status).toBe("disconnected");
  });

  it("getConnectedNodes filters disconnected", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    manager.registerNode(ws1, REG);
    manager.registerNode(ws2, { ...REG, node_id: "beta" });

    expect(manager.getConnectedNodes()).toHaveLength(2);

    // ws1 연결 끊김
    (ws1 as unknown as EventEmitter).emit("close");

    expect(manager.getConnectedNodes()).toHaveLength(1);
    expect(manager.getConnectedNodes()[0].nodeId).toBe("beta");
  });
});

describe("NodeConnection", () => {
  it("sends create_session command", async () => {
    const ws = createMockWs();
    const conn = new NodeConnection(ws, REG);

    // send가 호출되면 바로 session_created 응답 시뮬레이션
    (ws.send as ReturnType<typeof vi.fn>).mockImplementation((data: string) => {
      const msg = JSON.parse(data);
      if (msg.type === "create_session") {
        // 응답 전달
        setTimeout(() => {
          (ws as unknown as EventEmitter).emit(
            "message",
            JSON.stringify({
              type: "session_created",
              session_id: "session-123",
              request_id: msg.request_id,
            })
          );
        }, 0);
      }
    });

    const sessionId = await conn.createSession("Hello");
    expect(sessionId).toBe("session-123");
  });

  it("dispatches session events to listeners", () => {
    const ws = createMockWs();
    const conn = new NodeConnection(ws, REG);

    const events: unknown[] = [];
    conn.onSessionEvent("session-1", (e) => events.push(e));

    // 이벤트 시뮬레이션
    (ws as unknown as EventEmitter).emit(
      "message",
      JSON.stringify({
        type: "event",
        session_id: "session-1",
        event: { type: "progress", text: "Working..." },
      })
    );

    expect(events).toHaveLength(1);
  });

  it("unsubscribe stops event delivery", () => {
    const ws = createMockWs();
    const conn = new NodeConnection(ws, REG);

    const events: unknown[] = [];
    const unsub = conn.onSessionEvent("session-1", (e) => events.push(e));
    unsub();

    (ws as unknown as EventEmitter).emit(
      "message",
      JSON.stringify({
        type: "event",
        session_id: "session-1",
        event: { type: "progress", text: "Working..." },
      })
    );

    expect(events).toHaveLength(0);
  });

  it("handles sessions_update message", () => {
    const ws = createMockWs();
    const conn = new NodeConnection(ws, REG);

    (ws as unknown as EventEmitter).emit(
      "message",
      JSON.stringify({
        type: "sessions_update",
        sessions: [
          { sessionId: "s1", status: "running" },
          { sessionId: "s2", status: "completed" },
        ],
      })
    );

    expect(conn.getSessions()).toHaveLength(2);
  });

  it("rejects pending requests on close", async () => {
    const ws = createMockWs();
    const conn = new NodeConnection(ws, REG);

    // send는 응답을 보내지 않음
    (ws.send as ReturnType<typeof vi.fn>).mockImplementation(() => {});

    const promise = conn.createSession("Hello");

    // 즉시 close
    (ws as unknown as EventEmitter).emit("close");

    await expect(promise).rejects.toThrow("Node disconnected");
  });

  it("toInfo returns correct structure", () => {
    const ws = createMockWs();
    const conn = new NodeConnection(ws, REG);

    const info = conn.toInfo();
    expect(info.nodeId).toBe("alpha");
    expect(info.host).toBe("localhost");
    expect(info.port).toBe(3105);
    expect(info.status).toBe("connected");
    expect(info.sessionCount).toBe(0);
  });
});

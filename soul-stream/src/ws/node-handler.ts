/**
 * WebSocket /ws/node 엔드포인트 — 소울 서버 노드 연결 수신.
 *
 * 소울 서버의 UpstreamAdapter가 이 엔드포인트에 WebSocket으로 연결한다.
 * 첫 번째 메시지로 node_register를 보내면 NodeManager에 등록된다.
 */

import type { Server } from "http";
import { WebSocketServer } from "ws";
import type { NodeManager } from "../nodes/node-manager";
import type { NodeRegistration } from "../nodes/types";

export function setupNodeWebSocket(
  server: Server,
  nodeManager: NodeManager
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws/node" });

  wss.on("connection", (ws) => {
    let registered = false;

    // 첫 번째 메시지가 node_register여야 한다
    const registrationTimeout = setTimeout(() => {
      if (!registered) {
        ws.close(4001, "Registration timeout");
      }
    }, 10000);

    ws.on("message", (data) => {
      if (registered) return; // 등록 후에는 NodeConnection이 메시지를 처리

      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "node_register") {
          clearTimeout(registrationTimeout);
          registered = true;

          const registration: NodeRegistration = {
            type: "node_register",
            node_id: msg.node_id ?? "",
            host: msg.host ?? "",
            port: msg.port ?? 0,
            capabilities: msg.capabilities ?? {},
          };

          if (!registration.node_id) {
            ws.close(4002, "node_id is required");
            return;
          }

          nodeManager.registerNode(ws, registration);
        } else {
          ws.close(4003, "First message must be node_register");
        }
      } catch {
        ws.close(4004, "Invalid JSON");
      }
    });

    ws.on("close", () => {
      clearTimeout(registrationTimeout);
    });
  });

  return wss;
}

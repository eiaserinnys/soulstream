/**
 * SessionRouter — 세션 생성 요청을 적절한 노드로 라우팅.
 */

import type { NodeManager } from "../nodes/node-manager";
import type { CreateSessionRequest } from "./types";

export class SessionRouter {
  constructor(private _nodeManager: NodeManager) {}

  /** 세션 생성 요청을 적절한 노드로 라우팅. */
  async createSession(
    request: CreateSessionRequest
  ): Promise<{ nodeId: string; sessionId: string }> {
    let node;

    if (request.nodeId) {
      // 지정된 노드에 생성
      node = this._nodeManager.getNode(request.nodeId);
      if (!node) {
        throw new Error(`Node not found: ${request.nodeId}`);
      }
      if (node.status !== "connected") {
        throw new Error(`Node is disconnected: ${request.nodeId}`);
      }
    } else {
      // 가용한 노드에 자동 할당 (가장 세션이 적은 노드)
      const connected = this._nodeManager.getConnectedNodes();
      if (connected.length === 0) {
        throw new Error("No connected nodes available");
      }

      node = connected.reduce((best, current) =>
        current.getSessions().length < best.getSessions().length
          ? current
          : best
      );
    }

    const sessionId = await node.createSession(request.prompt, {
      profile: request.profile,
      allowed_tools: request.allowed_tools,
      disallowed_tools: request.disallowed_tools,
      use_mcp: request.use_mcp,
    });

    return { nodeId: node.nodeId, sessionId };
  }
}

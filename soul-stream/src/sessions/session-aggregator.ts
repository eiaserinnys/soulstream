/**
 * SessionAggregator — 전체 노드의 세션 목록을 집계.
 */

import type { NodeManager } from "../nodes/node-manager";
import type { AggregatedSession } from "./types";

export class SessionAggregator {
  constructor(private _nodeManager: NodeManager) {}

  /** 전체 노드의 세션 목록을 집계하여 반환. */
  getAllSessions(nodeId?: string): AggregatedSession[] {
    const result: AggregatedSession[] = [];

    if (nodeId) {
      const node = this._nodeManager.getNode(nodeId);
      if (node) {
        for (const session of node.getSessions()) {
          result.push({
            nodeId: node.nodeId,
            sessionId: session.sessionId,
            summary: session,
          });
        }
      }
    } else {
      for (const nodeInfo of this._nodeManager.getNodes()) {
        const node = this._nodeManager.getNode(nodeInfo.nodeId);
        if (node) {
          for (const session of node.getSessions()) {
            result.push({
              nodeId: nodeInfo.nodeId,
              sessionId: session.sessionId,
              summary: session,
            });
          }
        }
      }
    }

    return result;
  }

  /** 특정 세션을 찾아 해당 노드 ID와 함께 반환. */
  findSession(
    sessionId: string
  ): { nodeId: string; session: AggregatedSession } | null {
    for (const nodeInfo of this._nodeManager.getNodes()) {
      const node = this._nodeManager.getNode(nodeInfo.nodeId);
      if (!node) continue;

      for (const session of node.getSessions()) {
        if (session.sessionId === sessionId) {
          return {
            nodeId: nodeInfo.nodeId,
            session: {
              nodeId: nodeInfo.nodeId,
              sessionId: session.sessionId,
              summary: session,
            },
          };
        }
      }
    }
    return null;
  }
}

/**
 * NodeManager — 소울 서버 노드 등록/관리.
 *
 * WebSocket으로 연결하는 소울 서버 노드를 추적하고,
 * 노드 상태 변경 이벤트를 구독자에게 전달한다.
 */

import type { WebSocket } from "ws";
import { NodeConnection } from "./node-connection";
import type { NodeRegistration, NodeInfo, NodeChangeEvent } from "./types";

export class NodeManager {
  private _nodes: Map<string, NodeConnection> = new Map();
  private _listeners: Set<(event: NodeChangeEvent) => void> = new Set();

  /** 소울 서버 노드가 WebSocket으로 연결하면 등록. */
  registerNode(ws: WebSocket, registration: NodeRegistration): NodeConnection {
    const existing = this._nodes.get(registration.node_id);
    if (existing) {
      // 기존 연결이 있으면 교체 (재연결 시나리오)
      existing.close();
    }

    const conn = new NodeConnection(ws, registration);
    this._nodes.set(conn.nodeId, conn);

    conn.onClose = () => {
      this._emit({
        type: "node_status_changed",
        nodeId: conn.nodeId,
        node: conn.toInfo(),
      });
    };

    this._emit({
      type: "node_registered",
      nodeId: conn.nodeId,
      node: conn.toInfo(),
    });

    return conn;
  }

  /** 노드 연결 해제 시 정리. 세션 정보는 유지하되 상태를 disconnected로 변경. */
  unregisterNode(nodeId: string): void {
    const conn = this._nodes.get(nodeId);
    if (!conn) return;

    conn.close();
    this._nodes.delete(nodeId);

    this._emit({
      type: "node_unregistered",
      nodeId,
    });
  }

  /** 특정 노드 조회. */
  getNode(nodeId: string): NodeConnection | undefined {
    return this._nodes.get(nodeId);
  }

  /** 전체 노드 목록 + 상태 조회. */
  getNodes(): NodeInfo[] {
    return Array.from(this._nodes.values()).map((n) => n.toInfo());
  }

  /** 연결된(connected) 노드 목록. */
  getConnectedNodes(): NodeConnection[] {
    return Array.from(this._nodes.values()).filter(
      (n) => n.status === "connected"
    );
  }

  /** 노드 상태 변경 이벤트 구독. 해제 함수를 반환한다. */
  onNodeChange(listener: (event: NodeChangeEvent) => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /** 등록된 노드 수. */
  get size(): number {
    return this._nodes.size;
  }

  private _emit(event: NodeChangeEvent): void {
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch {
        // 리스너 에러 무시
      }
    }
  }
}

/**
 * Orchestrator 대시보드 타입 정의.
 */

export interface OrchestratorNode {
  nodeId: string;
  host: string;
  port: number;
  status: "connected" | "disconnected";
  capabilities: Record<string, unknown>;
  connectedAt: number;
  sessionCount: number;
}

export interface OrchestratorSession {
  sessionId: string;
  nodeId: string;
  status: "running" | "idle" | "completed" | "error";
  lastMessage?: { preview?: string; timestamp?: string; type?: string };
  updatedAt?: string;
  createdAt?: string;
  prompt?: string;
}

/** SSE로 수신하는 노드 변경 이벤트 */
export interface NodeChangeSSE {
  type: "node_connected" | "node_disconnected" | "node_updated";
  node: OrchestratorNode;
}

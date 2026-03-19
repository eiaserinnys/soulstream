/** 소울 서버 노드 관련 타입 정의. */

export interface NodeRegistration {
  type: "node_register";
  node_id: string;
  host: string;
  port: number;
  capabilities: {
    max_concurrent?: number;
    [key: string]: unknown;
  };
}

export type NodeStatus = "connected" | "disconnected";

export interface NodeInfo {
  nodeId: string;
  host: string;
  port: number;
  status: NodeStatus;
  capabilities: Record<string, unknown>;
  connectedAt: number;
  sessionCount: number;
}

export interface NodeChangeEvent {
  type: "node_registered" | "node_unregistered" | "node_status_changed";
  nodeId: string;
  node?: NodeInfo;
}

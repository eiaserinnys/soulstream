import type {
  NodeCommandRequestIdGenerator,
  PendingNodeCommands,
  RequestResponseNodeCommandPayload,
} from "./pending_commands.js";
import type {
  CachedNodeSession,
  PerNodeSessionCache,
} from "./session_cache.js";

export type NodeRegistrationPayload = {
  type: "node_register";
  node_id: string;
  host?: string;
  port?: number;
  agents?: unknown[];
  capabilities?: Record<string, unknown>;
  supported_backends?: string[];
  sessions?: unknown[];
  [key: string]: unknown;
};

export type CreateSessionNodeCommandPayload =
  RequestResponseNodeCommandPayload<"create_session"> & {
    agentSessionId: string;
    prompt: string;
  };

export type SessionOwner = CachedNodeSession & {
  connected: boolean;
};

export type NodeHeartbeatState = {
  // Observability only. The worker owns heartbeat liveness and closes its socket.
  supported: boolean;
  lastPingAtMs: number | undefined;
  lastPongAtMs: number | undefined;
};

export type NodeConnectionSnapshot = {
  nodeId: string;
  connectionId: string;
  host: string;
  port: number;
  agents: unknown[];
  capabilities: Record<string, unknown>;
  supportedBackends: string[];
  connected: boolean;
  status: "connected" | "disconnected";
  connectedAtMs: number;
  disconnectedAtMs: number | undefined;
  lastSeenAtMs: number;
  heartbeat: NodeHeartbeatState;
  pendingCommandCount: number;
};

export type NodeRegisteredEvent = {
  type: "node_registered";
  nodeId: string;
  connectionId: string;
};

export type NodeUpdatedEvent = {
  type: "node_updated";
  nodeId: string;
  connectionId: string;
  node: NodeConnectionSnapshot;
};

export type NodeUnregisteredEvent = {
  type: "node_unregistered";
  nodeId: string;
  connectionId: string;
  reason: string;
};

export type IgnoredStaleDisconnectEvent = {
  type: "ignored_stale_disconnect";
  nodeId: string;
  connectionId: string;
};

export type IgnoredStaleMessageEvent = {
  type: "ignored_stale_message";
  nodeId: string;
  connectionId: string;
  currentConnectionId: string | undefined;
  messageType: string;
};

export type IgnoredNodeRegistrationRefreshEvent = {
  type: "ignored_node_registration_refresh";
  nodeId: string;
  connectionId: string;
  incomingNodeId: string | undefined;
  reason: "node_id_mismatch";
};

export type NodeSessionEvent = {
  type: "node_session_event";
  nodeId: string;
  data: Record<string, unknown>;
};

export type NodeSessionCreatedEvent = {
  type: "node_session_session_created";
  nodeId: string;
  data: Record<string, unknown>;
};

export type NodeSessionUpdatedEvent = {
  type: "node_session_session_updated";
  nodeId: string;
  data: Record<string, unknown>;
};

export type NodeSessionDeletedEvent = {
  type: "node_session_session_deleted";
  nodeId: string;
  data: Record<string, unknown>;
};

export type NodeSessionsUpdateEvent = {
  type: "node_session_sessions_update";
  nodeId: string;
  data: Record<string, unknown>;
};

export type NodeCommandAckEvent = {
  type: "command_ack";
  nodeId: string;
  requestId: string;
  commandType: string;
};

export type NodeCommandErrorEvent = {
  type: "command_error";
  nodeId: string;
  requestId: string;
  commandType: string;
  message: string;
};

export type NodeHeartbeatPongEvent = {
  type: "node_heartbeat_pong";
  nodeId: string;
};

export type NodeHeartbeatPingEvent = {
  type: "node_heartbeat_ping";
  nodeId: string;
};

export type NodeRegistryEvent =
  | NodeRegisteredEvent
  | NodeUpdatedEvent
  | NodeUnregisteredEvent
  | IgnoredStaleDisconnectEvent
  | IgnoredStaleMessageEvent
  | IgnoredNodeRegistrationRefreshEvent
  | NodeSessionEvent
  | NodeSessionCreatedEvent
  | NodeSessionUpdatedEvent
  | NodeSessionDeletedEvent
  | NodeSessionsUpdateEvent
  | NodeCommandAckEvent
  | NodeCommandErrorEvent
  | NodeHeartbeatPongEvent
  | NodeHeartbeatPingEvent;

export type NodeRegistrationResult = {
  node: NodeConnectionSnapshot;
  event: NodeRegisteredEvent;
  events: Array<NodeRegisteredEvent | NodeUnregisteredEvent>;
  replacedConnectionId: string | undefined;
};

export type DisconnectNodeInput =
  | string
  | {
      connectionId?: string;
      reason?: string;
    };

export type NodeMessageSource =
  | string
  | {
      nodeId: string;
      connectionId?: string;
    };

export type InMemoryNodeRegistryOptions = {
  sessionCache?: PerNodeSessionCache;
  nowMs?: () => number;
  requestIdGenerator?: NodeCommandRequestIdGenerator;
};

export type MutableNodeConnection = {
  nodeId: string;
  connectionId: string;
  host: string;
  port: number;
  agents: unknown[];
  capabilities: Record<string, unknown>;
  supportedBackends: string[];
  userInfo: Record<string, unknown>;
  connected: boolean;
  connectedAtMs: number;
  disconnectedAtMs: number | undefined;
  lastSeenAtMs: number;
  heartbeat: NodeHeartbeatState;
  pendingCommands: PendingNodeCommands;
};

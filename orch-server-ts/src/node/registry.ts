import {
  PendingNodeCommands,
  type FireAndForgetNodeCommandPayload,
  type NodeFireAndForgetCommand,
  type NodeCommandRequestIdGenerator,
  type NodeCommandResponse,
  type PendingNodeCommand,
  type RequestResponseNodeCommandPayload,
} from "./pending_commands.js";
import {
  ignoredStaleMessageEvent,
  isRecord,
  normalizeMessageSource,
  snapshotNode,
  supportsAppHeartbeat,
} from "./registry_helpers.js";
import { PerNodeSessionCache } from "./session_cache.js";
import { collectDirectNodeSessionEvents } from "./session_message_events.js";
import type {
  DisconnectNodeInput,
  InMemoryNodeRegistryOptions,
  MutableNodeConnection,
  NodeConnectionSnapshot,
  NodeMessageSource,
  NodeRegisteredEvent,
  NodeRegistrationPayload,
  NodeRegistrationResult,
  NodeRegistryEvent,
  NodeUnregisteredEvent,
  SessionOwner,
} from "./registry_types.js";

export type {
  CreateSessionNodeCommandPayload,
  DisconnectNodeInput,
  IgnoredNodeRegistrationRefreshEvent,
  IgnoredStaleDisconnectEvent,
  IgnoredStaleMessageEvent,
  InMemoryNodeRegistryOptions,
  MutableNodeConnection,
  NodeCommandAckEvent,
  NodeCommandErrorEvent,
  NodeConnectionSnapshot,
  NodeHeartbeatPingEvent,
  NodeHeartbeatPongEvent,
  NodeHeartbeatState,
  NodeMessageSource,
  NodeRegisteredEvent,
  NodeRegistrationPayload,
  NodeRegistrationResult,
  NodeRegistryEvent,
  NodeSessionCreatedEvent,
  NodeSessionDeletedEvent,
  NodeSessionEvent,
  NodeSessionUpdatedEvent,
  NodeSessionsUpdateEvent,
  NodeUpdatedEvent,
  NodeUnregisteredEvent,
  SessionOwner,
} from "./registry_types.js";

export class InMemoryNodeRegistry {
  readonly sessionCache: PerNodeSessionCache;

  private readonly nowMs: () => number;
  private readonly requestIdGenerator: NodeCommandRequestIdGenerator | undefined;
  private readonly nodes = new Map<string, MutableNodeConnection>();
  private connectionSequence = 0;

  constructor(options: InMemoryNodeRegistryOptions = {}) {
    this.sessionCache = options.sessionCache ?? new PerNodeSessionCache();
    this.nowMs = options.nowMs ?? Date.now;
    this.requestIdGenerator = options.requestIdGenerator;
  }

  registerNode(registration: NodeRegistrationPayload): NodeRegistrationResult {
    if (registration.type !== "node_register") {
      throw new Error(`registration.type must be node_register: ${registration.type}`);
    }
    if (registration.node_id.length === 0) {
      throw new Error("registration.node_id must be non-empty");
    }

    const nowMs = this.nowMs();
    const existing = this.nodes.get(registration.node_id);
    const events: Array<NodeRegisteredEvent | NodeUnregisteredEvent> = [];
    let replacedConnectionId: string | undefined;

    if (existing?.connected) {
      replacedConnectionId = existing.connectionId;
      const disconnectEvent = this.disconnectCurrentNode(
        existing,
        nowMs,
        "replaced_by_reconnect",
      );
      events.push(disconnectEvent);
    }

    const node: MutableNodeConnection = {
      nodeId: registration.node_id,
      connectionId: this.nextConnectionId(registration.node_id),
      host: typeof registration.host === "string" ? registration.host : "",
      port: typeof registration.port === "number" ? registration.port : 0,
      agents: Array.isArray(registration.agents) ? registration.agents : [],
      capabilities: isRecord(registration.capabilities)
        ? { ...registration.capabilities }
        : {},
      supportedBackends: Array.isArray(registration.supported_backends)
        ? [...registration.supported_backends]
        : ["claude"],
      connected: true,
      connectedAtMs: nowMs,
      disconnectedAtMs: undefined,
      lastSeenAtMs: nowMs,
      heartbeat: {
        supported: supportsAppHeartbeat(registration.capabilities),
        lastPingAtMs: undefined,
        lastPongAtMs: undefined,
      },
      pendingCommands: new PendingNodeCommands({
        nowMs: this.nowMs,
        requestIdGenerator: this.requestIdGenerator,
      }),
    };

    this.nodes.set(node.nodeId, node);
    const event: NodeRegisteredEvent = {
      type: "node_registered",
      nodeId: node.nodeId,
      connectionId: node.connectionId,
    };
    events.push(event);

    return {
      node: snapshotNode(node),
      event,
      events,
      replacedConnectionId,
    };
  }

  refreshNodeRegistration(
    source: NodeMessageSource,
    registration: NodeRegistrationPayload,
  ): NodeRegistryEvent[] {
    const { nodeId, connectionId } = normalizeMessageSource(source);
    const node = this.requireConnectedNode(nodeId);
    if (connectionId !== undefined && node.connectionId !== connectionId) {
      return [
        ignoredStaleMessageEvent({
          nodeId,
          connectionId,
          currentConnectionId: node.connectionId,
          message: registration,
        }),
      ];
    }

    const incomingNodeId =
      typeof registration.node_id === "string" ? registration.node_id : undefined;
    if (incomingNodeId !== undefined && incomingNodeId !== nodeId) {
      return [
        {
          type: "ignored_node_registration_refresh",
          nodeId,
          connectionId: node.connectionId,
          incomingNodeId,
          reason: "node_id_mismatch",
        },
      ];
    }

    const nowMs = this.nowMs();
    node.lastSeenAtMs = nowMs;
    if ("host" in registration) {
      node.host = typeof registration.host === "string" ? registration.host : "";
    }
    if ("port" in registration) {
      node.port = typeof registration.port === "number" ? registration.port : 0;
    }
    if ("capabilities" in registration) {
      node.capabilities = isRecord(registration.capabilities)
        ? { ...registration.capabilities }
        : {};
      node.heartbeat.supported = supportsAppHeartbeat(node.capabilities);
    }
    if ("supported_backends" in registration) {
      node.supportedBackends = Array.isArray(registration.supported_backends)
        ? [...registration.supported_backends]
        : ["claude"];
    }
    if ("agents" in registration) {
      node.agents = Array.isArray(registration.agents) ? [...registration.agents] : [];
    }

    const events: NodeRegistryEvent[] = [
      {
        type: "node_updated",
        nodeId,
        connectionId: node.connectionId,
        node: snapshotNode(node),
      },
    ];
    if (Array.isArray(registration.sessions)) {
      const data = { type: "sessions_update", sessions: registration.sessions };
      this.sessionCache.replaceNodeSessions({
        nodeId,
        connectionId: node.connectionId,
        sessions: registration.sessions,
        nowMs,
      });
      events.push({ type: "node_session_sessions_update", nodeId, data });
    }
    return events;
  }

  getConnectedNode(nodeId: string): NodeConnectionSnapshot | undefined {
    const node = this.nodes.get(nodeId);
    if (node === undefined || !node.connected) return undefined;
    return snapshotNode(node);
  }

  listConnectedNodes(): NodeConnectionSnapshot[] {
    return [...this.nodes.values()]
      .filter((node) => node.connected)
      .map(snapshotNode)
      .sort((left, right) => {
        const nodeOrder = left.nodeId.localeCompare(right.nodeId);
        return nodeOrder === 0
          ? left.connectionId.localeCompare(right.connectionId)
          : nodeOrder;
      });
  }

  getNodeState(nodeId: string): NodeConnectionSnapshot | undefined {
    const node = this.nodes.get(nodeId);
    return node === undefined ? undefined : snapshotNode(node);
  }

  createCommand<
    TPayload extends RequestResponseNodeCommandPayload,
    TResponse extends NodeCommandResponse = NodeCommandResponse,
  >(
    nodeId: string,
    payload: TPayload,
    options: { timeoutMs?: number } = {},
  ): PendingNodeCommand<TPayload, TResponse> {
    const node = this.requireConnectedNode(nodeId);
    return node.pendingCommands.createCommand<TPayload, TResponse>(payload, options);
  }

  createFireAndForgetCommand<TPayload extends FireAndForgetNodeCommandPayload>(
    nodeId: string,
    payload: TPayload,
  ): NodeFireAndForgetCommand<TPayload> {
    const node = this.requireConnectedNode(nodeId);
    return node.pendingCommands.createFireAndForgetCommand(payload);
  }

  rejectCommand(
    source: NodeMessageSource,
    requestId: string,
    message: string,
    response?: NodeCommandResponse,
  ): boolean {
    const { nodeId, connectionId } = normalizeMessageSource(source);
    const node = this.nodes.get(nodeId);
    if (node === undefined) return false;
    if (connectionId !== undefined && node.connectionId !== connectionId) {
      return false;
    }
    return node.pendingCommands.reject(requestId, message, response);
  }

  receiveNodeMessage(
    source: NodeMessageSource,
    message: Record<string, unknown>,
  ): NodeRegistryEvent[] {
    const { nodeId, connectionId } = normalizeMessageSource(source);
    const node = this.requireConnectedNode(nodeId);
    if (connectionId !== undefined && node.connectionId !== connectionId) {
      return [
        ignoredStaleMessageEvent({
          nodeId,
          connectionId,
          currentConnectionId: node.connectionId,
          message,
        }),
      ];
    }

    const nowMs = this.nowMs();
    node.lastSeenAtMs = nowMs;

    if (message.type === "app_heartbeat_pong") {
      node.heartbeat.lastPongAtMs = nowMs;
      return [{ type: "node_heartbeat_pong", nodeId }];
    }

    if (message.type === "app_heartbeat_ping") {
      node.heartbeat.lastPingAtMs = nowMs;
      return [{ type: "node_heartbeat_ping", nodeId }];
    }

    if (typeof message.requestId === "string" && message.requestId.length > 0) {
      const settlement = node.pendingCommands.settleFromResponse(
        message as NodeCommandResponse,
      );
      if (settlement.status === "resolved") {
        if (message.type === "session_created") {
          this.sessionCache.upsertFromCommandAck({
            nodeId,
            connectionId: node.connectionId,
            response: message as NodeCommandResponse,
            nowMs,
          });
        }
        return [
          {
            type: "command_ack",
            nodeId,
            requestId: settlement.requestId,
            commandType: settlement.commandType,
          },
        ];
      }
      if (settlement.status === "rejected") {
        return [
          {
            type: "command_error",
            nodeId,
            requestId: settlement.requestId,
            commandType: settlement.commandType,
            message: settlement.message,
          },
        ];
      }
      return [];
    }

    const directSessionEvents = collectDirectNodeSessionEvents({
      sessionCache: this.sessionCache,
      nodeId,
      connectionId: node.connectionId,
      message,
      nowMs,
    });
    if (directSessionEvents !== undefined) return directSessionEvents;

    if (message.type === "event") {
      this.sessionCache.upsertFromEventRelay({
        nodeId,
        connectionId: node.connectionId,
        message,
        nowMs,
      });
      return [{ type: "node_session_event", nodeId, data: message }];
    }

    if (message.type === "sessions_update") {
      this.sessionCache.replaceNodeSessions({
        nodeId,
        connectionId: node.connectionId,
        sessions: Array.isArray(message.sessions) ? message.sessions : [],
        nowMs,
      });
      return [{ type: "node_session_sessions_update", nodeId, data: message }];
    }

    return [];
  }

  disconnectNode(nodeId: string, input: DisconnectNodeInput): NodeRegistryEvent {
    const node = this.nodes.get(nodeId);
    const requestedConnectionId =
      typeof input === "string" ? undefined : input.connectionId;
    const reason = typeof input === "string" ? input : input.reason;

    if (
      requestedConnectionId !== undefined &&
      node?.connectionId !== requestedConnectionId
    ) {
      return {
        type: "ignored_stale_disconnect",
        nodeId,
        connectionId: requestedConnectionId,
      };
    }

    if (node === undefined || !node.connected) {
      return {
        type: "ignored_stale_disconnect",
        nodeId,
        connectionId: requestedConnectionId ?? "",
      };
    }

    return this.disconnectCurrentNode(node, this.nowMs(), reason ?? "disconnect");
  }

  findConnectedNodeForSession(
    agentSessionId: string,
  ): NodeConnectionSnapshot | undefined {
    const session = this.sessionCache.findSession(agentSessionId);
    if (session === undefined || !session.fresh) return undefined;
    const node = this.nodes.get(session.nodeId);
    if (
      node === undefined ||
      !node.connected ||
      node.connectionId !== session.connectionId
    ) {
      return undefined;
    }
    return snapshotNode(node);
  }

  findSessionOwner(agentSessionId: string): SessionOwner | undefined {
    const session = this.sessionCache.findSession(agentSessionId);
    if (session === undefined) return undefined;
    const node = this.nodes.get(session.nodeId);
    return {
      ...session,
      connected:
        node?.connected === true && node.connectionId === session.connectionId,
    };
  }

  private requireConnectedNode(nodeId: string): MutableNodeConnection {
    const node = this.nodes.get(nodeId);
    if (node === undefined || !node.connected) {
      throw new Error(`node is not connected: ${nodeId}`);
    }
    return node;
  }

  private disconnectCurrentNode(
    node: MutableNodeConnection,
    nowMs: number,
    reason: string,
  ): NodeUnregisteredEvent {
    node.connected = false;
    node.disconnectedAtMs = nowMs;
    node.lastSeenAtMs = nowMs;
    node.pendingCommands.rejectAll(`Node disconnected: ${reason}`);
    this.sessionCache.markNodeDisconnected(node.nodeId, nowMs);
    return {
      type: "node_unregistered",
      nodeId: node.nodeId,
      connectionId: node.connectionId,
      reason,
    };
  }

  private nextConnectionId(nodeId: string): string {
    this.connectionSequence += 1;
    return `${nodeId}:${this.connectionSequence}`;
  }
}

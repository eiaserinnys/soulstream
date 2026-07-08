import type {
  NodeCommandResponse,
  NodeFireAndForgetCommand,
  PendingNodeCommand,
  RequestResponseNodeCommandPayload,
  RespondNodeCommandPayload,
  SubscribeEventsNodeCommandPayload,
} from "../node/pending_commands.js";
import type {
  CreateSessionNodeCommandPayload,
  NodeConnectionSnapshot,
} from "../node/registry.js";
import { InMemoryNodeRegistry } from "../node/registry.js";

export type SessionCommandRouterOptions = {
  registry: InMemoryNodeRegistry;
};

export type RoutedPendingSessionCommand<
  TPayload extends RequestResponseNodeCommandPayload,
  TResponse extends NodeCommandResponse = NodeCommandResponse,
> = {
  node: NodeConnectionSnapshot;
  command: PendingNodeCommand<TPayload, TResponse>;
};

export type ExistingSessionPendingNodeCommandPayload =
  RequestResponseNodeCommandPayload & {
    agentSessionId: string;
  };

export type RoutedFireAndForgetSessionCommand<
  TPayload extends SubscribeEventsNodeCommandPayload,
> = {
  node: NodeConnectionSnapshot;
  command: NodeFireAndForgetCommand<TPayload>;
};

export type SessionRouteErrorCode =
  | "NO_AVAILABLE_NODE"
  | "SESSION_OWNER_MISSING"
  | "SESSION_OWNER_STALE"
  | "NODE_UNAVAILABLE";

export class SessionCommandRouteError extends Error {
  readonly code: SessionRouteErrorCode;
  readonly agentSessionId: string | undefined;
  readonly nodeId: string | undefined;

  constructor(params: {
    code: SessionRouteErrorCode;
    message: string;
    agentSessionId?: string;
    nodeId?: string;
  }) {
    super(params.message);
    this.name = "SessionCommandRouteError";
    this.code = params.code;
    this.agentSessionId = params.agentSessionId;
    this.nodeId = params.nodeId;
  }
}

export class SessionRouteNoAvailableNodesError extends SessionCommandRouteError {
  constructor() {
    super({
      code: "NO_AVAILABLE_NODE",
      message: "No connected node is available for create_session",
    });
    this.name = "SessionRouteNoAvailableNodesError";
  }
}

export class SessionRouteSessionOwnerMissingError extends SessionCommandRouteError {
  constructor(agentSessionId: string) {
    super({
      code: "SESSION_OWNER_MISSING",
      message: `Session owner is missing: ${agentSessionId}`,
      agentSessionId,
    });
    this.name = "SessionRouteSessionOwnerMissingError";
  }
}

export class SessionRouteSessionOwnerStaleError extends SessionCommandRouteError {
  constructor(params: { agentSessionId: string; nodeId: string }) {
    super({
      code: "SESSION_OWNER_STALE",
      message: `Session owner is stale: ${params.agentSessionId} on ${params.nodeId}`,
      agentSessionId: params.agentSessionId,
      nodeId: params.nodeId,
    });
    this.name = "SessionRouteSessionOwnerStaleError";
  }
}

export class SessionRouteNodeUnavailableError extends SessionCommandRouteError {
  constructor(params: { agentSessionId: string; nodeId: string }) {
    super({
      code: "NODE_UNAVAILABLE",
      message: `Session owner node is unavailable: ${params.nodeId}`,
      agentSessionId: params.agentSessionId,
      nodeId: params.nodeId,
    });
    this.name = "SessionRouteNodeUnavailableError";
  }
}

export class SessionCommandRouter {
  private readonly registry: InMemoryNodeRegistry;

  constructor(options: SessionCommandRouterOptions) {
    this.registry = options.registry;
  }

  createSession<
    TPayload extends CreateSessionNodeCommandPayload,
    TResponse extends NodeCommandResponse = NodeCommandResponse,
  >(
    payload: TPayload,
    options: { timeoutMs?: number } = {},
  ): RoutedPendingSessionCommand<TPayload, TResponse> {
    const node = this.selectNodeForCreateSession();
    return {
      node,
      command: this.registry.createCommand<TPayload, TResponse>(
        node.nodeId,
        payload,
        options,
      ),
    };
  }

  respond<
    TPayload extends RespondNodeCommandPayload,
    TResponse extends NodeCommandResponse = NodeCommandResponse,
  >(
    payload: TPayload,
    options: { timeoutMs?: number } = {},
  ): RoutedPendingSessionCommand<TPayload, TResponse> {
    const node = this.requireNodeForExistingSession(payload.agentSessionId);
    return {
      node,
      command: this.registry.createCommand<TPayload, TResponse>(
        node.nodeId,
        payload,
        options,
      ),
    };
  }

  routeExistingSessionPendingCommand<
    TPayload extends ExistingSessionPendingNodeCommandPayload,
    TResponse extends NodeCommandResponse = NodeCommandResponse,
  >(
    payload: TPayload,
    options: { timeoutMs?: number } = {},
  ): RoutedPendingSessionCommand<TPayload, TResponse> {
    const node = this.requireNodeForExistingSession(payload.agentSessionId);
    return {
      node,
      command: this.registry.createCommand<TPayload, TResponse>(
        node.nodeId,
        payload,
        options,
      ),
    };
  }

  subscribeEvents<TPayload extends SubscribeEventsNodeCommandPayload>(
    payload: TPayload,
  ): RoutedFireAndForgetSessionCommand<TPayload> {
    const node = this.requireNodeForExistingSession(payload.agentSessionId);
    return {
      node,
      command: this.registry.createFireAndForgetCommand(node.nodeId, payload),
    };
  }

  private selectNodeForCreateSession(): NodeConnectionSnapshot {
    const [node] = this.registry.listConnectedNodes();
    if (node === undefined) {
      throw new SessionRouteNoAvailableNodesError();
    }
    return node;
  }

  private requireNodeForExistingSession(
    agentSessionId: string,
  ): NodeConnectionSnapshot {
    const owner = this.registry.findSessionOwner(agentSessionId);
    if (owner === undefined) {
      throw new SessionRouteSessionOwnerMissingError(agentSessionId);
    }
    if (!owner.fresh) {
      throw new SessionRouteSessionOwnerStaleError({
        agentSessionId,
        nodeId: owner.nodeId,
      });
    }

    const connectedNode = this.registry.findConnectedNodeForSession(agentSessionId);
    if (connectedNode === undefined) {
      throw new SessionRouteNodeUnavailableError({
        agentSessionId,
        nodeId: owner.nodeId,
      });
    }
    return connectedNode;
  }
}

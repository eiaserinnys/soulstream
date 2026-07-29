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
import {
  SessionCreateNodeSelectionError,
  selectNodeForSessionCreate,
  type SessionCreateNodeSelection,
} from "./session_create_node_selector.js";

export type SessionCommandRouterOptions = {
  registry: InMemoryNodeRegistry;
  findSessionOwnerNodeId?: SessionOwnerNodeIdLookup;
};

export type SessionOwnerNodeIdLookup = (
  agentSessionId: string,
) => Promise<string | null>;

const DEFAULT_SESSION_CREATE_RECONCILE_TIMEOUT_MS = 5_000;

export type RoutedPendingSessionCommand<
  TPayload extends RequestResponseNodeCommandPayload,
  TResponse extends NodeCommandResponse = NodeCommandResponse,
> = {
  node: NodeConnectionSnapshot;
  command: PendingNodeCommand<TPayload, TResponse>;
  modelPresetId?: string;
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
  private readonly findSessionOwnerNodeId: SessionOwnerNodeIdLookup | undefined;

  constructor(options: SessionCommandRouterOptions) {
    this.registry = options.registry;
    this.findSessionOwnerNodeId = options.findSessionOwnerNodeId;
  }

  createSession<
    TPayload extends CreateSessionNodeCommandPayload,
    TResponse extends NodeCommandResponse = NodeCommandResponse,
  >(
    payload: TPayload,
    options: {
      timeoutMs?: number;
      beforeCreateCommand?: (selection: SessionCreateNodeSelection) => void;
    } = {},
  ): RoutedPendingSessionCommand<TPayload, TResponse> {
    let selection;
    try {
      selection = selectNodeForSessionCreate(this.registry, {
        nodeId: optionalNonEmptyString(payload.nodeId),
        profileId: optionalNonEmptyString(payload.profile),
        modelPresetId: optionalNonEmptyString(payload.model_preset),
        legacyModelSpecified: optionalNonEmptyString(payload.model) !== undefined,
      });
    } catch (error) {
      if (
        error instanceof SessionCreateNodeSelectionError &&
        error.code === "NO_AVAILABLE_NODE"
      ) {
        throw new SessionRouteNoAvailableNodesError();
      }
      throw error;
    }
    options.beforeCreateCommand?.(selection);
    const { nodeId: _nodeId, ...commandPayload } = payload;
    const selectedPayload = {
      ...commandPayload,
      profile: selection.profileId,
      ...(selection.modelPresetId
        ? { model_preset: selection.modelPresetId }
        : {}),
    } as unknown as TPayload;
    return {
      node: selection.node,
      command: this.registry.createCommand<TPayload, TResponse>(
        selection.node.nodeId,
        selectedPayload,
        { timeoutMs: options.timeoutMs },
      ),
      ...(selection.modelPresetId
        ? { modelPresetId: selection.modelPresetId }
        : {}),
    };
  }

  waitForCreatedSession(
    agentSessionId: string,
    expectedNodeId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<boolean> {
    const timeoutMs =
      options.timeoutMs ?? DEFAULT_SESSION_CREATE_RECONCILE_TIMEOUT_MS;
    return this.registry.sessionCache.waitForSession({
      nodeId: expectedNodeId,
      agentSessionId,
      timeoutMs,
    });
  }

  async respond<
    TPayload extends RespondNodeCommandPayload,
    TResponse extends NodeCommandResponse = NodeCommandResponse,
  >(
    payload: TPayload,
    options: { timeoutMs?: number } = {},
  ): Promise<RoutedPendingSessionCommand<TPayload, TResponse>> {
    const node = await this.requireNodeForExistingSession(
      payload.agentSessionId,
    );
    return {
      node,
      command: this.registry.createCommand<TPayload, TResponse>(
        node.nodeId,
        payload,
        options,
      ),
    };
  }

  async routeExistingSessionPendingCommand<
    TPayload extends ExistingSessionPendingNodeCommandPayload,
    TResponse extends NodeCommandResponse = NodeCommandResponse,
  >(
    payload: TPayload,
    options: { timeoutMs?: number } = {},
  ): Promise<RoutedPendingSessionCommand<TPayload, TResponse>> {
    const node = await this.requireNodeForExistingSession(
      payload.agentSessionId,
    );
    return {
      node,
      command: this.registry.createCommand<TPayload, TResponse>(
        node.nodeId,
        payload,
        options,
      ),
    };
  }

  async subscribeEvents<TPayload extends SubscribeEventsNodeCommandPayload>(
    payload: TPayload,
  ): Promise<RoutedFireAndForgetSessionCommand<TPayload>> {
    const node = await this.requireNodeForExistingSession(
      payload.agentSessionId,
    );
    return {
      node,
      command: this.registry.createFireAndForgetCommand(node.nodeId, payload),
    };
  }

  private async requireNodeForExistingSession(
    agentSessionId: string,
  ): Promise<NodeConnectionSnapshot> {
    const owner = this.registry.findSessionOwner(agentSessionId);
    if (owner === undefined) {
      const durableNodeId =
        (await this.findSessionOwnerNodeId?.(agentSessionId)) ?? null;
      if (durableNodeId === null) {
        throw new SessionRouteSessionOwnerMissingError(agentSessionId);
      }
      const durableNode = this.registry.getConnectedNode(durableNodeId);
      if (durableNode === undefined) {
        throw new SessionRouteNodeUnavailableError({
          agentSessionId,
          nodeId: durableNodeId,
        });
      }
      return durableNode;
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

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

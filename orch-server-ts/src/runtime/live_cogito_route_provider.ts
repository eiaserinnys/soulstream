import type {
  CogitoBriefCollector,
  CogitoNode,
  CogitoNodeProvider,
  CogitoSearchProvider,
} from "../cogito/cogito_routes.js";
import {
  CogitoBriefTimeoutError,
  CogitoBriefUnavailableError,
} from "../cogito/cogito_routes.js";
import {
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
  type NodeCommandResponse,
  type PendingNodeCommand,
  type RequestResponseNodeCommandPayload,
} from "../node/pending_commands.js";
import type { NodeConnectionSnapshot } from "../node/registry_types.js";
import {
  NodeCommandTransportError,
  type SessionCommandTransportBridge,
} from "../session/session_command_transport.js";

export type LiveCogitoNodeRegistry = {
  readonly listConnectedNodes: () => readonly NodeConnectionSnapshot[];
};

export type LiveCogitoBriefRegistry = {
  readonly getConnectedNode: (nodeId: string) => NodeConnectionSnapshot | undefined;
  readonly createCommand: <
    TPayload extends RequestResponseNodeCommandPayload,
    TResponse extends NodeCommandResponse = NodeCommandResponse,
  >(
    nodeId: string,
    payload: TPayload,
    options?: { timeoutMs?: number },
  ) => PendingNodeCommand<TPayload, TResponse>;
};

export type CreateLiveCogitoRouteProviderOptions = {
  readonly registry: LiveCogitoNodeRegistry;
};

export type LiveCogitoCommandBridge = Pick<
  SessionCommandTransportBridge,
  "sendPendingCommand"
>;

export type CreateLiveCogitoBriefCollectorOptions = {
  readonly registry: LiveCogitoBriefRegistry;
  readonly bridge: LiveCogitoCommandBridge;
};

export type CreateLiveCogitoRouteProvidersOptions =
  CreateLiveCogitoRouteProviderOptions &
  CreateLiveCogitoBriefCollectorOptions & {
    readonly searchProvider: CogitoSearchProvider;
  };

export type LiveCogitoRouteProviderBundle = {
  readonly cogitoRoutes: {
    readonly provider: CogitoNodeProvider;
    readonly searchProvider: CogitoSearchProvider;
    readonly briefCollector: CogitoBriefCollector;
  };
};

export function createLiveCogitoRouteProvider(
  options: CreateLiveCogitoRouteProviderOptions,
): CogitoNodeProvider {
  return {
    listConnectedNodes: () => listConnectedNodes(options.registry),
  };
}

export function createLiveCogitoRouteProviders(
  options: CreateLiveCogitoRouteProvidersOptions,
): LiveCogitoRouteProviderBundle {
  return {
    cogitoRoutes: {
      provider: createLiveCogitoRouteProvider(options),
      searchProvider: options.searchProvider,
      briefCollector: createLiveCogitoBriefCollector(options),
    },
  };
}

export function createLiveCogitoBriefCollector(
  options: CreateLiveCogitoBriefCollectorOptions,
): CogitoBriefCollector {
  return {
    reflectBrief: async (node, timeoutSeconds) => {
      const current = options.registry.getConnectedNode(node.id);
      if (current === undefined) {
        throw unavailableError(`Node is not connected: ${node.id}`);
      }

      const command = options.registry.createCommand<
        ReflectBriefCommandPayload,
        ReflectBriefCommandResponse
      >(node.id, { type: "reflect_brief" }, {
        timeoutMs: briefTimeoutMs(timeoutSeconds),
      });

      try {
        return await options.bridge.sendPendingCommand({
          node: current,
          command,
        });
      } catch (error) {
        throw mapReflectBriefCommandError(error);
      }
    },
  };
}

function listConnectedNodes(registry: LiveCogitoNodeRegistry): CogitoNode[] {
  return registry.listConnectedNodes().map((node) => ({
    id: node.nodeId,
    host: node.host,
    port: node.port,
    capabilities: { ...node.capabilities },
  }));
}

type ReflectBriefCommandPayload = RequestResponseNodeCommandPayload<"reflect_brief">;

type ReflectBriefCommandResponse = NodeCommandResponse & {
  type: "reflect_brief";
  ok?: unknown;
  checked_at?: unknown;
  brief?: unknown;
};

function briefTimeoutMs(timeoutSeconds: number): number {
  const timeoutMs = Math.ceil(timeoutSeconds * 1000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`brief timeoutSeconds must be positive: ${timeoutSeconds}`);
  }
  return timeoutMs;
}

function mapReflectBriefCommandError(error: unknown): unknown {
  if (error instanceof PendingNodeCommandTimeoutError) {
    return new CogitoBriefTimeoutError(error.message);
  }
  if (error instanceof NodeCommandTransportError) {
    return unavailableError(error.message);
  }
  if (
    error instanceof PendingNodeCommandRejectedError &&
    error.message.startsWith("Node disconnected:")
  ) {
    return unavailableError(error.message);
  }
  return error;
}

function unavailableError(message: string): CogitoBriefUnavailableError {
  return new CogitoBriefUnavailableError(message);
}

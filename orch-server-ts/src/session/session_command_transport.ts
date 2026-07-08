import type {
  NodeCommandResponse,
  RequestResponseNodeCommandPayload,
  SubscribeEventsNodeCommandPayload,
} from "../node/pending_commands.js";
import type { InMemoryNodeRegistry } from "../node/registry.js";
import type {
  NodeCommandTransportHub,
  NodeCommandTransportKey,
} from "../node/transport_hub.js";
import type {
  RoutedFireAndForgetSessionCommand,
  RoutedPendingSessionCommand,
} from "./session_command_router.js";

export type NodeCommandTransportErrorCode =
  | "TRANSPORT_MISSING"
  | "TRANSPORT_STALE"
  | "TRANSPORT_JSON_FAILED"
  | "TRANSPORT_SEND_FAILED";

export class NodeCommandTransportError extends Error {
  readonly code: NodeCommandTransportErrorCode;
  readonly nodeId: string;
  readonly connectionId: string;

  constructor(params: {
    code: NodeCommandTransportErrorCode;
    nodeId: string;
    connectionId: string;
    message: string;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "NodeCommandTransportError";
    this.code = params.code;
    this.nodeId = params.nodeId;
    this.connectionId = params.connectionId;
  }
}

export type SessionCommandTransportBridgeOptions = {
  registry: InMemoryNodeRegistry;
  transports: NodeCommandTransportHub;
};

export class SessionCommandTransportBridge {
  private readonly registry: InMemoryNodeRegistry;
  private readonly transports: NodeCommandTransportHub;

  constructor(options: SessionCommandTransportBridgeOptions) {
    this.registry = options.registry;
    this.transports = options.transports;
  }

  async sendPendingCommand<
    TPayload extends RequestResponseNodeCommandPayload,
    TResponse extends NodeCommandResponse,
  >(
    routed: RoutedPendingSessionCommand<TPayload, TResponse>,
  ): Promise<TResponse> {
    try {
      await this.sendMessage(routed.node, routed.command.message);
    } catch (error) {
      this.registry.rejectCommand(
        routed.node,
        routed.command.requestId,
        error instanceof Error ? error.message : String(error),
      );
      void routed.command.result.catch(() => undefined);
      throw error;
    }
    return routed.command.result;
  }

  async sendFireAndForgetCommand<
    TPayload extends SubscribeEventsNodeCommandPayload,
  >(
    routed: RoutedFireAndForgetSessionCommand<TPayload>,
  ): Promise<void> {
    await this.sendMessage(routed.node, routed.command.message);
  }

  private async sendMessage(
    key: NodeCommandTransportKey,
    message: Record<string, unknown>,
  ): Promise<void> {
    const current = this.registry.getConnectedNode(key.nodeId);
    if (current === undefined || current.connectionId !== key.connectionId) {
      throw new NodeCommandTransportError({
        code: "TRANSPORT_STALE",
        nodeId: key.nodeId,
        connectionId: key.connectionId,
        message: `Node transport is stale: ${key.nodeId}/${key.connectionId}`,
      });
    }

    const transport = this.transports.get(key);
    if (transport === undefined) {
      throw new NodeCommandTransportError({
        code: "TRANSPORT_MISSING",
        nodeId: key.nodeId,
        connectionId: key.connectionId,
        message: `Node transport is missing: ${key.nodeId}/${key.connectionId}`,
      });
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(message);
    } catch (error) {
      throw new NodeCommandTransportError({
        code: "TRANSPORT_JSON_FAILED",
        nodeId: key.nodeId,
        connectionId: key.connectionId,
        message: `Node command serialization failed: ${key.nodeId}/${key.connectionId}`,
        cause: error,
      });
    }

    try {
      await transport.send(serialized);
    } catch (error) {
      throw new NodeCommandTransportError({
        code: "TRANSPORT_SEND_FAILED",
        nodeId: key.nodeId,
        connectionId: key.connectionId,
        message: `Node command send failed: ${key.nodeId}/${key.connectionId}`,
        cause: error,
      });
    }
  }
}

import { InMemoryNodeRegistry } from "./registry.js";
import type {
  NodeConnectionSnapshot,
  NodeRegistrationPayload,
  NodeRegistryEvent,
} from "./registry_types.js";

export type NodeWsFrameRegistrationRejectCode =
  | "EXPECTED_NODE_REGISTER"
  | "NODE_ID_REQUIRED"
  | "NODE_ID_INVALID"
  | "RUNNER_REQUIRES_LEASE_RECONCILIATION"
  | "RUNNER_LEASE_TIMEOUT_INVALID"
  | "RUNNER_LEASE_TIMEOUT_MISMATCH";

export type NodeRunnerRegistrationWarning = {
  nodeId: string;
  reason: "runner_process_not_enabled";
};

export type NodeRunnerRegistrationPolicy = {
  leaseAware: boolean;
  leaseTimeoutMs: number;
  onWarning?(warning: NodeRunnerRegistrationWarning): void;
};

export type NodeWsFrameControllerOptions = {
  registry: InMemoryNodeRegistry;
  runnerPolicy?: NodeRunnerRegistrationPolicy;
};

export type NodeWsFrameRegistrationRejectedResult = {
  type: "registration_rejected";
  code: NodeWsFrameRegistrationRejectCode;
  messageType: string;
};

export type NodeWsFrameRegisteredResult = {
  type: "registered";
  nodeId: string;
  connectionId: string;
  node: NodeConnectionSnapshot;
  events: NodeRegistryEvent[];
};

export type NodeWsFrameRegistrationRefreshedResult = {
  type: "registration_refreshed";
  nodeId: string;
  connectionId: string;
  events: NodeRegistryEvent[];
};

export type NodeWsFrameRegistrationRefreshIgnoredResult = {
  type: "registration_refresh_ignored";
  nodeId: string;
  connectionId: string;
  events: NodeRegistryEvent[];
};

export type NodeWsFrameMessageResult = {
  type: "message";
  nodeId: string;
  connectionId: string;
  events: NodeRegistryEvent[];
  outboundFrames?: NodeWsOutboundFrame[];
};

export type NodeWsOutboundFrame = {
  type: "app_heartbeat_pong";
  sentAt: unknown;
};

export type NodeWsFrameIgnoredAfterCloseResult = {
  type: "frame_ignored_after_close";
  messageType: string;
};

export type NodeWsFrameControllerResult =
  | NodeWsFrameRegistrationRejectedResult
  | NodeWsFrameRegisteredResult
  | NodeWsFrameRegistrationRefreshedResult
  | NodeWsFrameRegistrationRefreshIgnoredResult
  | NodeWsFrameMessageResult
  | NodeWsFrameIgnoredAfterCloseResult;

export type NodeWsFrameCloseResult =
  | {
      type: "closed";
      nodeId: string;
      connectionId: string;
      event: NodeRegistryEvent;
    }
  | {
      type: "close_ignored";
      reason: "not_registered" | "already_closed";
    };

export class NodeWsFrameController {
  private readonly registry: InMemoryNodeRegistry;
  private readonly runnerPolicy: NodeRunnerRegistrationPolicy | undefined;
  private registered:
    | {
        nodeId: string;
        connectionId: string;
      }
    | undefined;
  private closed = false;

  constructor(options: NodeWsFrameControllerOptions) {
    this.registry = options.registry;
    this.runnerPolicy = options.runnerPolicy;
  }

  handleFrame(frame: Record<string, unknown>): NodeWsFrameControllerResult {
    if (this.closed) {
      return { type: "frame_ignored_after_close", messageType: messageType(frame) };
    }
    if (this.registered === undefined) {
      return this.handleRegistrationFrame(frame);
    }
    if (frame.type === "node_register") {
      const rejection = validateRunnerCompatibility(frame, this.runnerPolicy);
      if (rejection !== undefined) return rejection;
      return this.handleRegistrationRefresh(frame);
    }

    const events = this.registry.receiveNodeMessage(this.registered, frame);
    const result: NodeWsFrameMessageResult = {
      type: "message",
      nodeId: this.registered.nodeId,
      connectionId: this.registered.connectionId,
      events,
    };
    if (frame.type === "app_heartbeat_ping") {
      result.outboundFrames = [{
        type: "app_heartbeat_pong",
        sentAt: frame.sentAt,
      }];
    }
    return result;
  }

  close(reason = "disconnect"): NodeWsFrameCloseResult {
    if (this.registered === undefined) {
      return { type: "close_ignored", reason: "not_registered" };
    }
    if (this.closed) {
      return { type: "close_ignored", reason: "already_closed" };
    }

    const event = this.registry.disconnectNode(this.registered.nodeId, {
      connectionId: this.registered.connectionId,
      reason,
    });
    this.closed = true;
    return {
      type: "closed",
      nodeId: this.registered.nodeId,
      connectionId: this.registered.connectionId,
      event,
    };
  }

  private handleRegistrationFrame(
    frame: Record<string, unknown>,
  ): NodeWsFrameRegistrationRejectedResult | NodeWsFrameRegisteredResult {
    const rejection = validateRegistrationFrame(frame, this.runnerPolicy);
    if (rejection !== undefined) return rejection;

    const registration = frame as NodeRegistrationPayload;
    const result = this.registry.registerNode(registration);
    this.registered = {
      nodeId: result.node.nodeId,
      connectionId: result.node.connectionId,
    };
    return {
      type: "registered",
      nodeId: result.node.nodeId,
      connectionId: result.node.connectionId,
      node: result.node,
      events: result.events,
    };
  }

  private handleRegistrationRefresh(
    frame: Record<string, unknown>,
  ):
    | NodeWsFrameRegistrationRefreshedResult
    | NodeWsFrameRegistrationRefreshIgnoredResult {
    if (this.registered === undefined) {
      throw new Error("registration refresh received before registration");
    }

    const events = this.registry.refreshNodeRegistration(
      this.registered,
      frame as NodeRegistrationPayload,
    );
    const ignored = events.every((event) => event.type !== "node_updated");
    return {
      type: ignored ? "registration_refresh_ignored" : "registration_refreshed",
      nodeId: this.registered.nodeId,
      connectionId: this.registered.connectionId,
      events,
    };
  }
}

function validateRegistrationFrame(
  frame: Record<string, unknown>,
  runnerPolicy: NodeRunnerRegistrationPolicy | undefined,
): NodeWsFrameRegistrationRejectedResult | undefined {
  if (frame.type !== "node_register") {
    return {
      type: "registration_rejected",
      code: "EXPECTED_NODE_REGISTER",
      messageType: messageType(frame),
    };
  }
  if (!("node_id" in frame) || frame.node_id === "") {
    return {
      type: "registration_rejected",
      code: "NODE_ID_REQUIRED",
      messageType: "node_register",
    };
  }
  if (typeof frame.node_id !== "string") {
    return {
      type: "registration_rejected",
      code: "NODE_ID_INVALID",
      messageType: "node_register",
    };
  }
  return validateRunnerCompatibility(frame, runnerPolicy);
}

function validateRunnerCompatibility(
  frame: Record<string, unknown>,
  policy: NodeRunnerRegistrationPolicy | undefined,
): NodeWsFrameRegistrationRejectedResult | undefined {
  if (!policy) return undefined;
  const capabilities = isRecord(frame.capabilities) ? frame.capabilities : {};
  const runnerEnabled = capabilities.runner_process_v1 === true;
  if (!runnerEnabled) {
    if (policy.leaseAware && typeof frame.node_id === "string") {
      policy.onWarning?.({
        nodeId: frame.node_id,
        reason: "runner_process_not_enabled",
      });
    }
    return undefined;
  }
  if (!policy.leaseAware) {
    return runnerRejection("RUNNER_REQUIRES_LEASE_RECONCILIATION");
  }
  const leaseTimeoutMs = capabilities.runner_lease_timeout_ms;
  if (!Number.isInteger(leaseTimeoutMs) || (leaseTimeoutMs as number) <= 0) {
    return runnerRejection("RUNNER_LEASE_TIMEOUT_INVALID");
  }
  if (leaseTimeoutMs !== policy.leaseTimeoutMs) {
    return runnerRejection("RUNNER_LEASE_TIMEOUT_MISMATCH");
  }
  return undefined;
}

function runnerRejection(
  code: Extract<NodeWsFrameRegistrationRejectCode, `RUNNER_${string}`>,
): NodeWsFrameRegistrationRejectedResult {
  return { type: "registration_rejected", code, messageType: "node_register" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageType(frame: Record<string, unknown>): string {
  return typeof frame.type === "string" ? frame.type : "<unknown>";
}

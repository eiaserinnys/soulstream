import { InMemoryNodeRegistry } from "./registry.js";
import type {
  NodeConnectionSnapshot,
  NodeRegistrationPayload,
  NodeRegistryEvent,
} from "./registry_types.js";

export type NodeWsFrameRegistrationRejectCode =
  | "EXPECTED_NODE_REGISTER"
  | "NODE_ID_REQUIRED"
  | "NODE_ID_INVALID";

export type NodeWsFrameControllerOptions = {
  registry: InMemoryNodeRegistry;
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
  private registered:
    | {
        nodeId: string;
        connectionId: string;
      }
    | undefined;
  private closed = false;

  constructor(options: NodeWsFrameControllerOptions) {
    this.registry = options.registry;
  }

  handleFrame(frame: Record<string, unknown>): NodeWsFrameControllerResult {
    if (this.closed) {
      return { type: "frame_ignored_after_close", messageType: messageType(frame) };
    }
    if (this.registered === undefined) {
      return this.handleRegistrationFrame(frame);
    }
    if (frame.type === "node_register") {
      return this.handleRegistrationRefresh(frame);
    }

    const events = this.registry.receiveNodeMessage(this.registered, frame);
    return {
      type: "message",
      nodeId: this.registered.nodeId,
      connectionId: this.registered.connectionId,
      events,
    };
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
    const rejection = validateRegistrationFrame(frame);
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
  return undefined;
}

function messageType(frame: Record<string, unknown>): string {
  return typeof frame.type === "string" ? frame.type : "<unknown>";
}

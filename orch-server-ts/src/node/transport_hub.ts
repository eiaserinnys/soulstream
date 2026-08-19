export type NodeCommandTransportSend = (data: string) => void | Promise<void>;

export type NodeCommandTransport = {
  send: NodeCommandTransportSend;
};

export type NodeCommandTransportKey = {
  nodeId: string;
  connectionId: string;
};

export type NodeCommandTransportLane = "control" | "data";

export type NodeCommandTransportAttachment = NodeCommandTransportKey & {
  lane?: NodeCommandTransportLane;
  transport: NodeCommandTransport;
};

export class NodeCommandTransportHub {
  private readonly transports = new Map<string, NodeCommandTransportAttachment>();

  attach(attachment: NodeCommandTransportAttachment): void {
    const normalized = { ...attachment, lane: attachment.lane ?? "data" };
    this.transports.set(laneTransportKey(normalized, normalized.lane), normalized);
  }

  detach(attachment: NodeCommandTransportAttachment): boolean;
  detach(key: NodeCommandTransportKey): boolean;
  detach(input: NodeCommandTransportAttachment | NodeCommandTransportKey): boolean {
    if ("transport" in input) {
      const lane = input.lane ?? "data";
      const key = laneTransportKey(input, lane);
      const current = this.transports.get(key);
      if (current === undefined || current.transport !== input.transport) {
        return false;
      }
      return this.transports.delete(key);
    }
    let detached = false;
    for (const lane of ["control", "data"] as const) {
      detached = this.transports.delete(laneTransportKey(input, lane)) || detached;
    }
    return detached;
  }

  get(key: NodeCommandTransportKey): NodeCommandTransport | undefined {
    return this.transports.get(laneTransportKey(key, "control"))?.transport
      ?? this.transports.get(laneTransportKey(key, "data"))?.transport;
  }

  has(key: NodeCommandTransportKey): boolean {
    return this.get(key) !== undefined;
  }

  listAttached(): NodeCommandTransportKey[] {
    const unique = new Map<string, NodeCommandTransportKey>();
    for (const { nodeId, connectionId } of this.transports.values()) {
      unique.set(transportKey({ nodeId, connectionId }), { nodeId, connectionId });
    }
    return [...unique.values()]
      .sort((left, right) => {
        const nodeOrder = left.nodeId.localeCompare(right.nodeId);
        return nodeOrder === 0
          ? left.connectionId.localeCompare(right.connectionId)
          : nodeOrder;
      });
  }
}

function transportKey(key: NodeCommandTransportKey): string {
  return `${key.nodeId}\u0000${key.connectionId}`;
}

function laneTransportKey(
  key: NodeCommandTransportKey,
  lane: NodeCommandTransportLane,
): string {
  return `${transportKey(key)}\u0000${lane}`;
}

export type NodeCommandTransportSend = (data: string) => void | Promise<void>;

export type NodeCommandTransport = {
  send: NodeCommandTransportSend;
};

export type NodeCommandTransportKey = {
  nodeId: string;
  connectionId: string;
};

export type NodeCommandTransportAttachment = NodeCommandTransportKey & {
  transport: NodeCommandTransport;
};

export class NodeCommandTransportHub {
  private readonly transports = new Map<string, NodeCommandTransportAttachment>();

  attach(attachment: NodeCommandTransportAttachment): void {
    this.transports.set(transportKey(attachment), attachment);
  }

  detach(attachment: NodeCommandTransportAttachment): boolean;
  detach(key: NodeCommandTransportKey): boolean;
  detach(input: NodeCommandTransportAttachment | NodeCommandTransportKey): boolean {
    const key = transportKey(input);
    const current = this.transports.get(key);
    if (current === undefined) return false;
    if ("transport" in input && current.transport !== input.transport) {
      return false;
    }
    return this.transports.delete(key);
  }

  get(key: NodeCommandTransportKey): NodeCommandTransport | undefined {
    return this.transports.get(transportKey(key))?.transport;
  }

  has(key: NodeCommandTransportKey): boolean {
    return this.transports.has(transportKey(key));
  }

  listAttached(): NodeCommandTransportKey[] {
    return [...this.transports.values()]
      .map(({ nodeId, connectionId }) => ({ nodeId, connectionId }))
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

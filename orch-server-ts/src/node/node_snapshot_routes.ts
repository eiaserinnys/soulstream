import { Readable } from "node:stream";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { NodeRegistryEvent } from "./registry.js";
import type { NodeSnapshotRecord, NodeSnapshotService } from "./node_snapshot_service.js";

export type NodeStreamFrame = {
  event: "snapshot" | "node_connected" | "node_disconnected" | "node_updated";
  data: unknown;
};

export type NodeStreamSubscriber = (frame: NodeStreamFrame) => void;

export type NodeSnapshotRouteOptions = {
  snapshotService: NodeSnapshotService;
  broadcaster: InMemoryNodeStreamBroadcaster;
  keepaliveMs?: number;
  closeAfterInitialSnapshot?: boolean;
};

export const nodeSnapshotRouteAuthRequirements = {
  "GET /api/nodes": true,
  "GET /api/nodes/stream": true,
} as const;

const DEFAULT_KEEPALIVE_MS = 30_000;

export class InMemoryNodeStreamBroadcaster {
  private readonly snapshotService: NodeSnapshotService;
  private readonly subscribers = new Set<NodeStreamSubscriber>();

  constructor(options: { snapshotService: NodeSnapshotService }) {
    this.snapshotService = options.snapshotService;
  }

  subscribe(subscriber: NodeStreamSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  publishRegistryEvents(events: NodeRegistryEvent[]): NodeStreamFrame[] {
    const frames = events.flatMap((event) => {
      const frame = this.frameFromRegistryEvent(event);
      return frame === undefined ? [] : [frame];
    });
    for (const frame of frames) {
      for (const subscriber of this.subscribers) {
        try {
          subscriber(frame);
        } catch {
          // Node registry state is canonical; stream delivery is best-effort.
        }
      }
    }
    return frames;
  }

  private frameFromRegistryEvent(event: NodeRegistryEvent): NodeStreamFrame | undefined {
    if (event.type === "node_registered") {
      const node = this.snapshotService.getNode(event.nodeId);
      return node === undefined
        ? undefined
        : {
            event: "node_connected",
            data: node,
          };
    }
    if (event.type === "node_updated") {
      return {
        event: "node_updated",
        data: this.snapshotService.projectNode(event.node),
      };
    }
    if (event.type === "node_unregistered") {
      return {
        event: "node_disconnected",
        data: { nodeId: event.nodeId },
      };
    }
    return undefined;
  }
}

export function createNodeStreamBroadcasterSink(
  broadcaster: InMemoryNodeStreamBroadcaster,
): (events: NodeRegistryEvent[]) => void {
  return (events) => {
    broadcaster.publishRegistryEvents(events);
  };
}

export function registerNodeSnapshotRoutes(
  app: FastifyInstance,
  options: NodeSnapshotRouteOptions,
): void {
  app.get("/api/nodes", async () => options.snapshotService.listNodes());
  app.get("/api/nodes/stream", async (request, reply) =>
    sendNodeStream(request, reply, options),
  );
}

export function formatNodeStreamFrame(frame: NodeStreamFrame): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

async function sendNodeStream(
  request: FastifyRequest,
  reply: FastifyReply,
  options: NodeSnapshotRouteOptions,
): Promise<FastifyReply> {
  setSseHeaders(reply);
  const snapshotFrame: NodeStreamFrame = {
    event: "snapshot",
    data: options.snapshotService.listNodes().nodes,
  };

  if (options.closeAfterInitialSnapshot) {
    return reply.send(formatNodeStreamFrame(snapshotFrame));
  }

  const stream = new Readable({
    read() {},
  });
  stream.push(formatNodeStreamFrame(snapshotFrame));

  const unsubscribe = options.broadcaster.subscribe((frame) => {
    stream.push(formatNodeStreamFrame(frame));
  });
  const keepalive = setInterval(() => {
    stream.push(": keepalive\n\n");
  }, options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS);
  const cleanup = () => {
    clearInterval(keepalive);
    unsubscribe();
  };
  request.raw.on("close", cleanup);
  stream.on("close", cleanup);

  return reply.send(stream);
}

function setSseHeaders(reply: FastifyReply): void {
  reply
    .header("content-type", "text/event-stream; charset=utf-8")
    .header("cache-control", "no-cache")
    .header("connection", "keep-alive");
}

export type { NodeSnapshotRecord };

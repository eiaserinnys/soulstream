import type { PerNodeSessionCache } from "./session_cache.js";
import type { NodeRegistryEvent } from "./registry_types.js";

export function collectDirectNodeSessionEvents(params: {
  sessionCache: PerNodeSessionCache;
  nodeId: string;
  connectionId: string;
  message: Record<string, unknown>;
  nowMs: number;
}): NodeRegistryEvent[] | undefined {
  if (params.message.type === "session_created") {
    params.sessionCache.upsertFromSessionCreated(params);
    return [
      {
        type: "node_session_session_created",
        nodeId: params.nodeId,
        data: params.message,
      },
    ];
  }

  if (params.message.type === "session_updated") {
    params.sessionCache.upsertFromSessionUpdated(params);
    return [
      {
        type: "node_session_session_updated",
        nodeId: params.nodeId,
        data: params.message,
      },
    ];
  }

  if (params.message.type === "session_deleted") {
    params.sessionCache.deleteFromSessionDeleted({ message: params.message });
    return [
      {
        type: "node_session_session_deleted",
        nodeId: params.nodeId,
        data: params.message,
      },
    ];
  }

  return undefined;
}

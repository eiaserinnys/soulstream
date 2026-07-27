import {
  MemoryStatsCollector,
  type MemoryStatsCollectorOptions,
} from "../system/memory_stats.js";

export type OrchestratorMemoryStatsComponents = {
  readonly sessionBroadcaster: {
    getStats: () => { bufferedEvents: number; listeners: number };
    getTypeCounts: () => Record<string, number>;
    approxBytes: () => number;
  };
  readonly sessionCache: {
    getStats: () => { nodes: number; sessions: number };
  };
  readonly registry: {
    getStats: () => {
      nodes: number;
      connectedNodes: number;
      pendingCommands: number;
    };
  };
  readonly pushNotifier: {
    getStats: () => {
      lastStatuses: number;
      toolInputs: number;
      pendingSends: number;
    };
  };
  readonly foregroundObservers: {
    getStats: () => { sessions: number; observers: number };
  };
  readonly boardYjsDocuments: () => number;
  readonly pageYjsDocuments: () => number;
  readonly collectorOptions?: MemoryStatsCollectorOptions;
};

export function createOrchestratorMemoryStatsCollector(
  components: OrchestratorMemoryStatsComponents,
): MemoryStatsCollector {
  const collector = new MemoryStatsCollector(components.collectorOptions);
  collector.registerSource({
    name: "session_replay_ring",
    entries: () => components.sessionBroadcaster.getStats().bufferedEvents,
    details: () => ({
      listeners: components.sessionBroadcaster.getStats().listeners,
      ...components.sessionBroadcaster.getTypeCounts(),
    }),
    approxBytes: () => components.sessionBroadcaster.approxBytes(),
  });
  collector.registerSource({
    name: "session_cache",
    entries: () => components.sessionCache.getStats().sessions,
    details: () => ({ nodes: components.sessionCache.getStats().nodes }),
  });
  collector.registerSource({
    name: "pending_commands",
    entries: () => components.registry.getStats().pendingCommands,
    details: () => {
      const stats = components.registry.getStats();
      return {
        nodes: stats.nodes,
        connectedNodes: stats.connectedNodes,
      };
    },
  });
  collector.registerSource({
    name: "push_notifier",
    entries: () => {
      const stats = components.pushNotifier.getStats();
      return stats.lastStatuses + stats.toolInputs + stats.pendingSends;
    },
    details: () => components.pushNotifier.getStats(),
  });
  collector.registerSource({
    name: "foreground_observers",
    entries: () => components.foregroundObservers.getStats().observers,
    details: () => ({
      sessions: components.foregroundObservers.getStats().sessions,
    }),
  });
  collector.registerSource({
    name: "board_yjs_documents",
    entries: components.boardYjsDocuments,
  });
  collector.registerSource({
    name: "page_yjs_documents",
    entries: components.pageYjsDocuments,
  });
  return collector;
}

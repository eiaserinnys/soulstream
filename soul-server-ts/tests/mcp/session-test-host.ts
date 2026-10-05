import Fastify from "fastify";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { registerMcpHostRoutes } from "../../../orch-server-ts/src/mcp/mcp_host_routes.js";
import type { McpHostOptions } from "../../../orch-server-ts/src/mcp/types.js";
import type { PersistenceHostRepositories } from "../../../orch-server-ts/src/control_plane/persistence_host_runtime.js";

/** Existing scenario doubles now sit behind the real orchestrator MCP HTTP boundary. */
export async function startSessionTestHost(runtime: McpRuntime, searchProvider?: { search: (...args: any[]) => any }, repositories?: PersistenceHostRepositories) {
  runtime.nodeId ??= "test-node";
  const db = runtime.db;
  const scenarioRepositories = repositories ?? {
    sessionReads: {
      getSession: (id: string) => db.getSession?.(id) ?? Promise.resolve(null),
      listSessionsSummary: (params: any) => db.listSessionsSummary(params),
    },
    eventReads: {
      readEvents: (...args: any[]) => (db.readEvents as Function)(...args),
      countEvents: (id: string) => db.countEvents(id),
      readOneEvent: (id: string, eventId: number) => db.readOneEvent(id, eventId),
      listUserMessages: (...args: any[]) => (db.listUserMessages as Function)(...args),
    },
    storyReads: {
      getSessionStory: (id: string) => db.getSessionStory(id),
      getSessionSearchMetadata: async (ids: string[]) => [...await db.getSessionSearchMetadata(ids)],
      countTurnSummaries: (id: string) => db.countTurnSummaries(id),
      loadTurnSummaryRange: (...args: any[]) => (db.loadTurnSummaryRange as Function)(...args),
      loadTurnTranscript: (...args: any[]) => (db.loadTurnTranscript as Function)(...args),
    },
    historySearch: { search: (params: any, signal: AbortSignal) => db.searchSessionHistory(params, signal) },
    sessionReadComposites: { getTurnExcerpt: (id: string, max: number) => db.getTurnExcerpt(id, max) },
    deliveries: { recordObservedChildCompletions: async (batch: any[]) => {
      if (runtime.childCompletionConsumption) await runtime.childCompletionConsumption.recordObservedBatch(batch.map(row => ({
        childSessionId: row.childSessionId, callerSessionId: row.callerSessionId,
        terminalRevision: row.observedRevision, source: row.consumedTurnId.split(":")[1],
      })));
      return { status: "recorded" };
    } },
  } as unknown as PersistenceHostRepositories;
  const app = Fastify();
  registerMcpHostRoutes(app, {
    authBearerToken: "test-token",
    folders: { serviceProvider: async () => ({ getAllFolders: () => db.getAllFolders() }) },
    sessions: { repositoryProvider: async () => scenarioRepositories,
      cogito: { provider: { listConnectedNodes: () => [] }, briefCollector: { reflectBrief: async () => ({}) }, searchProvider } },
  } as unknown as McpHostOptions);
  runtime.orch = { baseUrl: await app.listen({ host: "127.0.0.1", port: 0 }),
    headers: { authorization: "Bearer test-token" } };
  return app;
}

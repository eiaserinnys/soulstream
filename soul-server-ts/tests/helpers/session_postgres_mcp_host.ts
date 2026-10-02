import { EventReadRepository } from "../../../orch-server-ts/src/control_plane/repositories/event_read_repository.js";
import { SessionReadRepository } from "../../../orch-server-ts/src/control_plane/repositories/session_read_repository.js";
import { SessionStoryReadRepository } from "../../../orch-server-ts/src/control_plane/repositories/session_story_read_repository.js";
import { SessionReadCompositeRepository } from "../../../orch-server-ts/src/control_plane/repositories/session_read_composite.js";
import { SessionHistorySearchRepository } from "../../../orch-server-ts/src/control_plane/repositories/session_history_search_repository.js";
import { SessionDeliveryRepository } from "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import type { PersistenceHostRepositories } from "../../../orch-server-ts/src/control_plane/persistence_host_runtime.js";
import { createLiveSearchDbConnectionFactory } from "../../../orch-server-ts/src/runtime/live_db_sql.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import type { FullSchemaPostgresHarness } from "../db/full_schema_postgres_harness.js";
import { startSessionTestHost } from "../mcp/session-test-host.js";

/** Queries and consumption run in the orchestrator against the scenario's real PostgreSQL schema. */
export async function startSessionPostgresMcpHost(runtime: McpRuntime, harness: FullSchemaPostgresHarness) {
  const sql = harness.sql as never;
  const sessionReads = new SessionReadRepository(sql);
  const eventReads = new EventReadRepository(sql);
  const storyReads = new SessionStoryReadRepository(sql);
  const deliveries = new SessionDeliveryRepository(sql);
  const repositories = {
    sessionReads, eventReads, storyReads, deliveries,
    historySearch: new SessionHistorySearchRepository(
      createLiveSearchDbConnectionFactory({ databaseUrl: harness.databaseUrl }), eventReads, storyReads,
    ),
    sessionReadComposites: new SessionReadCompositeRepository(sessionReads, eventReads, storyReads),
  } as PersistenceHostRepositories;
  const app = await startSessionTestHost(runtime, undefined, repositories);
  return { app, deliveries };
}

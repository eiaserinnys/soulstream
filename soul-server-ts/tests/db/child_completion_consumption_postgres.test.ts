import { spawnSync } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from
  "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { CatalogService } from "../../src/catalog/catalog_service.js";
import { SessionDB } from "../../src/db/session_db.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildServer } from "../../src/server.js";
import { ChildCompletionConsumptionRecorder } from
  "../../src/task/child_completion_consumption.js";
import { CompletionDeliveryCoordinator } from
  "../../src/task/completion_delivery_coordinator.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres =
  hasFullSchemaPostgresBackend || hasDockerBinary() ? describe : describe.skip;
const logger = pino({ level: "silent" });

describePostgres("child completion observation PostgreSQL integration", () => {
  let harness: FullSchemaPostgresHarness;
  let db: SessionDB;
  let server: Awaited<ReturnType<typeof buildServer>>;
  let client: Client;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    db = new SessionDB(harness.sql);
    await harness.sql`
      INSERT INTO sessions (
        session_id, node_id, session_type, status, agent_id, caller_session_id
      ) VALUES
        ('caller-session', 'node-test', 'claude', 'completed', 'caller', NULL),
        (
          'child-session', 'node-test', 'claude', 'completed', 'child',
          'caller-session'
        )
    `;
    const terminalEventId = await db.appendEvent({
      sessionId: "child-session",
      eventType: "assistant_message",
      payload: JSON.stringify({ text: "child completed inline" }),
      searchableText: "child completed inline",
      createdAt: new Date("2026-07-26T00:00:00Z"),
    });
    await db.updateSession("child-session", {
      last_event_id: terminalEventId,
      status: "completed",
    });

    const runtime: McpRuntime = {
      nodeId: "node-test",
      agentsConfigPath: "/tmp/agents.yaml",
      db,
      taskManager: {} as TaskManager,
      taskExecutor: {} as TaskExecutor,
      childCompletionConsumption: new ChildCompletionConsumptionRecorder(
        db.sessionDeliveries(),
      ),
      agentRegistry: {} as McpRuntime["agentRegistry"],
      catalogService: {} as CatalogService,
      logger,
    };
    server = await buildServer({
      host: "127.0.0.1",
      port: 0,
      nodeId: runtime.nodeId,
      logger,
      mcp: {
        runtime,
        path: "/mcp",
        auth: {
          requireAuth: false,
          bearerToken: "",
          allowedHosts: ["127.0.0.1", "localhost"],
        },
      },
    });
    const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
    client = new Client({
      name: "child-completion-consumption-pg",
      version: "0.0.0",
    });
    await client.connect(new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      {
        requestInit: {
          headers: {
            "x-soulstream-agent-session-id": "caller-session",
          },
        },
      },
    ));
  }, 45_000);

  afterAll(async () => {
    await client?.close();
    if (server?.closeMcp) await server.closeMcp();
    await server?.close();
    await harness.cleanup();
  });

  it("records the real tool observation before suppressing the late notifier", async () => {
    const summary = await client.callTool({
      name: "get_session_summary",
      arguments: { session_id: "child-session" },
    });
    expect(summary.isError).not.toBe(true);
    const child = await db.getSession("child-session");
    const terminalRevision = String(child!.last_event_id);
    const relationKey = `child_session:child-session:${terminalRevision}`;
    await expect(
      db.sessionDeliveries().getRelationConsumption(relationKey),
    ).resolves.toMatchObject({
      relation_key: relationKey,
      caller_session_id: "caller-session",
      consumed_turn_id:
        `mcp:get_session_summary:child-session:${terminalRevision}`,
    });

    const dispatch = vi.fn(async () => undefined);
    const coordinator = new CompletionDeliveryCoordinator({
      repository: db.sessionDeliveries(),
      dispatch,
      logger,
    }, "late-notifier");
    await coordinator.enqueue({
      targetSessionId: "caller-session",
      sourceSessionId: "child-session",
      terminalRevision,
      text: "late duplicate child completion",
      callerInfo: {
        source: "agent",
        agent_id: "child",
      },
      createdAt: new Date("2026-07-26T00:01:00Z"),
    });

    expect(dispatch).not.toHaveBeenCalled();
    await expect(
      db.sessionDeliveries().getByRelation(relationKey),
    ).resolves.toMatchObject({
      state: "consumed",
      relation_key: relationKey,
    });
    expect(await harness.sql`
      SELECT delivery_id
      FROM session_delivery_notification_outbox
      WHERE delivery_id = (
        SELECT delivery_id FROM session_deliveries
        WHERE relation_key = ${relationKey}
      )
    `).toHaveLength(0);
  });
});

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}

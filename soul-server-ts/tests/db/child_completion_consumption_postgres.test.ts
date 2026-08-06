import { spawnSync } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from
  "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { CatalogService } from "../../src/catalog/catalog_service.js";
import { SessionDB } from "../../src/db/session_db.js";
import { SessionDeliveryRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
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
  let consumptionRecorder: ChildCompletionConsumptionRecorder;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    db = new SessionDB(harness.sql);
    db.configureSessionDeliveryHost(
      new SessionDeliveryRepository(harness.sql) as never,
    );
    await harness.sql`
      INSERT INTO sessions (
        session_id, node_id, session_type, status, agent_id, caller_session_id
      ) VALUES
        ('caller-session', 'node-test', 'claude', 'completed', 'caller', NULL)
    `;

    consumptionRecorder = new ChildCompletionConsumptionRecorder(
      db.sessionDeliveries(),
    );
    const runtime: McpRuntime = {
      nodeId: "node-test",
      agentsConfigPath: "/tmp/agents.yaml",
      db,
      taskManager: {} as TaskManager,
      taskExecutor: {} as TaskExecutor,
      childCompletionConsumption: consumptionRecorder,
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

  it("routes every child-result session query through one revision-checked consumption boundary", async () => {
    const cases = [
      {
        source: "list_session_events",
        call: async (sessionId: string, _revision: number, _text: string) =>
          await client.callTool({
            name: "list_session_events",
            arguments: { session_id: sessionId, limit: 20 },
          }),
      },
      {
        source: "get_session_event",
        call: async (sessionId: string, revision: number, _text: string) =>
          await client.callTool({
            name: "get_session_event",
            arguments: { session_id: sessionId, event_id: revision },
          }),
      },
      {
        source: "download_session_history",
        call: async (sessionId: string, _revision: number, _text: string) =>
          await client.callTool({
            name: "download_session_history",
            arguments: {
              session_id: sessionId,
              output_dir: "/tmp/soulstream_child_completion_boundary",
            },
          }),
      },
      {
        source: "search_session_history",
        call: async (sessionId: string, _revision: number, text: string) =>
          await client.callTool({
            name: "search_session_history",
            arguments: { query: text, session_ids: [sessionId], top_k: 10 },
          }),
      },
      {
        source: "get_session_summary",
        call: async (sessionId: string, _revision: number, _text: string) =>
          await client.callTool({
            name: "get_session_summary",
            arguments: { session_id: sessionId },
          }),
      },
    ] as const;

    let lateNotifierChild:
      | { sessionId: string; revision: number; relationKey: string }
      | undefined;
    for (const [index, testCase] of cases.entries()) {
      const sessionId = `child-session-${index}`;
      const text = `child-completion-boundary-${index}`;
      const revision = await createTerminalChild(sessionId, text);
      const response = await testCase.call(sessionId, revision, text);
      expect(response.isError, testCase.source).not.toBe(true);
      const relationKey = `child_session:${sessionId}:${revision}`;
      await expect(
        db.sessionDeliveries().getRelationConsumption(relationKey),
      ).resolves.toMatchObject({
        relation_key: relationKey,
        caller_session_id: "caller-session",
        consumed_turn_id:
          `mcp:${testCase.source}:${sessionId}:${revision}`,
      });
      lateNotifierChild ??= { sessionId, revision, relationKey };
    }

    const observed = lateNotifierChild!;

    const dispatch = vi.fn(async () => undefined);
    const coordinator = new CompletionDeliveryCoordinator({
      repository: db.sessionDeliveries(),
      dispatch,
      logger,
    }, "late-notifier");
    await coordinator.enqueue({
      targetSessionId: "caller-session",
      sourceSessionId: observed.sessionId,
      terminalRevision: String(observed.revision),
      text: "late duplicate child completion",
      callerInfo: {
        source: "agent",
        agent_id: "child",
      },
      createdAt: new Date("2026-07-26T00:01:00Z"),
    });

    expect(dispatch).not.toHaveBeenCalled();
    await expect(
      db.sessionDeliveries().getByRelation(observed.relationKey),
    ).resolves.toMatchObject({
      state: "consumed",
      relation_key: observed.relationKey,
    });
    expect(await harness.sql`
      SELECT delivery_id
      FROM session_delivery_notification_outbox
      WHERE delivery_id = (
        SELECT delivery_id FROM session_deliveries
        WHERE relation_key = ${observed.relationKey}
      )
    `).toHaveLength(0);
  });

  it("fails closed instead of recording a tombstone for a revision that changed after result assembly", async () => {
    const sessionId = "child-session-revision-race";
    const observedRevision = await createTerminalChild(
      sessionId,
      "revision-race-old",
    );
    const newerRevision = await db.appendEvent({
      sessionId,
      eventType: "assistant_message",
      payload: JSON.stringify({ text: "revision-race-new" }),
      searchableText: "revision-race-new",
      createdAt: new Date("2026-07-26T00:02:00Z"),
    });
    await harness.sql`
      UPDATE sessions
      SET last_event_id = ${newerRevision}, status = 'completed'
      WHERE session_id = ${sessionId}
    `;
    const recorder = new ChildCompletionConsumptionRecorder(
      db.sessionDeliveries(),
    );

    await expect(recorder.recordObserved({
      childSessionId: sessionId,
      callerSessionId: "caller-session",
      terminalRevision: observedRevision,
      source: "revision_race",
    })).resolves.toBe("revision_mismatch");
    await expect(
      db.sessionDeliveries().getRelationConsumption(
        `child_session:${sessionId}:${observedRevision}`,
      ),
    ).resolves.toBeNull();

    await expect(recorder.recordObserved({
      childSessionId: sessionId,
      callerSessionId: "caller-session",
      terminalRevision: newerRevision,
      source: "revision_race",
    })).resolves.toBe("recorded");
  });

  it("atomically rolls back every child observation when one search result revision changes", async () => {
    const text = "multi-child-atomic-observation";
    const childA = "child-session-batch-a";
    const childB = "child-session-batch-b";
    const revisionA = await createTerminalChild(childA, text);
    const revisionB = await createTerminalChild(childB, text);
    const original = consumptionRecorder.recordObservedBatch.bind(
      consumptionRecorder,
    );
    const recordSpy = vi.spyOn(
      consumptionRecorder,
      "recordObservedBatch",
    ).mockImplementation(async (observations) => {
      const newerRevision = await db.appendEvent({
        sessionId: childB,
        eventType: "assistant_message",
        payload: JSON.stringify({ text: `${text}-newer` }),
        searchableText: `${text}-newer`,
        createdAt: new Date("2026-07-26T00:03:00Z"),
      });
      await harness.sql`
        UPDATE sessions
        SET last_event_id = ${newerRevision}, status = 'completed'
        WHERE session_id = ${childB}
      `;
      return await original(observations);
    });

    const raced = await client.callTool({
      name: "search_session_history",
      arguments: {
        query: text,
        session_ids: [childA, childB],
        top_k: 10,
      },
    });
    expect(raced.isError).toBe(true);
    expect(JSON.stringify(raced.content)).toContain("revision_mismatch");
    await expect(db.sessionDeliveries().getRelationConsumption(
      `child_session:${childA}:${revisionA}`,
    )).resolves.toBeNull();
    await expect(db.sessionDeliveries().getRelationConsumption(
      `child_session:${childB}:${revisionB}`,
    )).resolves.toBeNull();

    recordSpy.mockRestore();
    const retried = await client.callTool({
      name: "search_session_history",
      arguments: {
        query: text,
        session_ids: [childA, childB],
        top_k: 10,
      },
    });
    expect(retried.isError).not.toBe(true);
    const latestB = await db.getSession(childB);
    expect(latestB?.last_event_id).not.toBe(revisionB);
    await expect(db.sessionDeliveries().getRelationConsumption(
      `child_session:${childA}:${revisionA}`,
    )).resolves.toMatchObject({
      caller_session_id: "caller-session",
    });
    await expect(db.sessionDeliveries().getRelationConsumption(
      `child_session:${childB}:${latestB!.last_event_id!}`,
    )).resolves.toMatchObject({
      caller_session_id: "caller-session",
    });
  });

  async function createTerminalChild(
    sessionId: string,
    text: string,
  ): Promise<number> {
    await harness.sql`
      INSERT INTO sessions (
        session_id, node_id, session_type, status, agent_id, caller_session_id
      ) VALUES (
        ${sessionId}, 'node-test', 'claude', 'running', 'child',
        'caller-session'
      )
    `;
    const terminalEventId = await db.appendEvent({
      sessionId,
      eventType: "assistant_message",
      payload: JSON.stringify({ text }),
      searchableText: text,
      createdAt: new Date("2026-07-26T00:00:00Z"),
    });
    await harness.sql`
      UPDATE sessions
      SET last_event_id = ${terminalEventId}, status = 'completed'
      WHERE session_id = ${sessionId}
    `;
    return terminalEventId;
  }
});

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}

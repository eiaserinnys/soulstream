import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SessionDB, type SqlClient } from "../../src/db/session_db.js";
import { SessionPageBindingRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_page_binding_repository.js";
import { SessionMutationRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_mutation_repository.js";
import { configureTestSessionDataHost } from "../helpers/session_data_test_host.js";

const TEST_DB_NAME = "session_db_integration_test";
const TEST_USER = "session_db_integration_test";
const TEST_PASSWORD = "session_db_integration_secret";

const hasPostgresTestBackend =
  Boolean(process.env.TEST_DATABASE_URL?.trim()) || hasDockerBinary();
const describePostgres = hasPostgresTestBackend ? describe : describe.skip;

describePostgres("SessionDB PostgreSQL integration", () => {
  let harness: PostgresHarness | undefined;
  let db: SessionDB;
  let sessionMutations: SessionMutationRepository;

  beforeAll(async () => {
    harness = await createHarness();
    await applyCurrentSchema(harness.sql);
    db = new SessionDB();
    configureTestSessionDataHost(db, harness.sql);
    db.configureSessionPageBindingHost(
      new SessionPageBindingRepository(harness.sql) as never,
    );
    sessionMutations = new SessionMutationRepository(harness.sql as never);
  }, 45_000);

  beforeEach(async () => {
    if (!harness) return;
    await harness.sql`DELETE FROM session_mutation_receipts`;
    await harness.sql`DELETE FROM sessions`;
  }, 15_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  }, 15_000);

  it("keeps session_get_all pagination stable for sessions with identical updated_at", async () => {
    const tiedUpdatedAt = new Date("2026-06-14T01:00:00Z");
    const oldUpdatedAt = new Date("2026-06-13T01:00:00Z");
    await harness!.sql`
      INSERT INTO sessions (session_id, updated_at, session_type, status)
      VALUES
        ('sess-a', ${tiedUpdatedAt}, 'claude', 'completed'),
        ('sess-c', ${tiedUpdatedAt}, 'claude', 'completed'),
        ('sess-b', ${tiedUpdatedAt}, 'claude', 'completed'),
        ('sess-old', ${oldUpdatedAt}, 'claude', 'completed')
    `;

    await applyCurrentSchema(harness!.sql);

    const firstPage = await harness!.sql<Array<{ session_id: string }>>`
      SELECT session_id FROM session_get_all(NULL, 2, 0)
    `;
    const secondPage = await harness!.sql<Array<{ session_id: string }>>`
      SELECT session_id FROM session_get_all(NULL, 2, 2)
    `;

    expect(firstPage.map((row) => row.session_id)).toEqual(["sess-c", "sess-b"]);
    expect(secondPage.map((row) => row.session_id)).toEqual(["sess-a", "sess-old"]);
    expect(new Set([...firstPage, ...secondPage].map((row) => row.session_id)).size).toBe(4);
  }, 45_000);

  it("persists one idempotent page-binding intent and advances its replay steps", async () => {
    await harness!.sql`
      INSERT INTO sessions (session_id, node_id, updated_at, session_type, status)
      VALUES ('sess-binding', 'node-1', NOW(), 'claude', 'running')
    `;
    const repository = db.sessionPageBindings();
    const input = {
      sessionId: "sess-binding",
      nodeId: "node-1",
      targetPageId: null,
      targetBlockId: null,
      targetExpectedVersion: null,
      initialPageState: "pending" as const,
      dailyDate: "2026-07-13",
      sessionType: "claude",
      legacyFolderId: null,
      legacyContainerKind: null,
      legacyContainerId: null,
      sourceTaskItemId: null,
    };
    const first = await repository.enqueue(input);
    const duplicate = await repository.enqueue({ ...input, dailyDate: "2026-07-14" });
    expect(first.daily_date).toBe("2026-07-13");
    expect(first.page_state).toBe("pending");
    expect(duplicate.daily_date).toBe("2026-07-13");
    expect(await repository.listDue("node-1")).toHaveLength(1);

    await harness!.sql`
      INSERT INTO sessions (session_id, node_id, updated_at, session_type, status)
      VALUES ('sess-excluded', 'node-1', NOW(), 'claude', 'running')
    `;
    const excluded = await repository.enqueue({
      ...input,
      sessionId: "sess-excluded",
      initialPageState: "bound",
    });
    expect(excluded.page_state).toBe("bound");
    expect(await repository.listDue("node-1")).toHaveLength(2);

    await repository.markPageBound("sess-binding");
    await repository.markLegacyCompleted("sess-binding");
    await repository.markLegacyCompleted("sess-excluded");
    expect(await repository.get("sess-binding")).toMatchObject({
      page_state: "bound",
      legacy_state: "completed",
    });
    expect(await repository.listDue("node-1")).toHaveLength(0);

    await harness!.sql`
      UPDATE session_page_bindings
      SET page_state = 'manual_repair', legacy_state = 'pending', next_retry_at = NOW()
      WHERE session_id = 'sess-binding'
    `;
    expect(await repository.listDue("node-1")).toHaveLength(0);
  });

  it("enforces exactly one primary session_ref across pages", async () => {
    await harness!.sql`
      INSERT INTO sessions (session_id, updated_at, session_type, status)
      VALUES ('sess-primary', NOW(), 'claude', 'running')
    `;
    await harness!.sql`
      INSERT INTO pages (id, title) VALUES ('page-a', 'Page A'), ('page-b', 'Page B');
    `;
    await harness!.sql`
      INSERT INTO blocks (id, page_id, position_key, block_type, properties)
      VALUES ('block-a', 'page-a', 'a', 'session_ref', ${harness!.sql.json({
        sessionId: "sess-primary", primary: true,
      })})
    `;
    await expect(harness!.sql`
      INSERT INTO blocks (id, page_id, position_key, block_type, properties)
      VALUES ('block-b', 'page-b', 'a', 'session_ref', ${harness!.sql.json({
        sessionId: "sess-primary", primary: true,
      })})
    `).rejects.toMatchObject({ code: "23505" });
  });

  it("keeps review registration, terminal, restart, and acknowledge transitions consistent", async () => {
    const now = new Date("2026-07-12T00:00:00Z");
    await sessionMutations.registerSession({
      idempotencyKey: "register:sess-review",
      sessionId: "sess-review",
      nodeId: "node-review",
      agentId: "codex-default",
      claudeSessionId: null,
      sessionType: "claude",
      prompt: "review me",
      clientId: null,
      status: "running",
      createdAt: now,
      updatedAt: now,
      callerSessionId: null,
      predecessorSessionId: null,
      reviewRequired: true,
      reviewState: "not_required",
    });

    await sessionMutations.transitionSession({
      idempotencyKey: "transition:sess-review:completed",
      sessionId: "sess-review",
      fields: { status: "completed", reviewState: "needs_review" },
      updatedAt: new Date("2026-07-12T00:01:00Z"),
    });
    await expect(sessionMutations.acknowledgeReview({
      idempotencyKey: "ack:sess-review:1",
      sessionId: "sess-review",
      updatedAt: new Date("2026-07-12T00:02:00Z"),
    })).resolves.toBe(
      "acknowledged",
    );
    await expect(sessionMutations.acknowledgeReview({
      idempotencyKey: "ack:sess-review:2",
      sessionId: "sess-review",
      updatedAt: new Date("2026-07-12T00:03:00Z"),
    })).resolves.toBe(
      "already_acknowledged",
    );

    await sessionMutations.transitionSession({
      idempotencyKey: "transition:sess-review:running",
      sessionId: "sess-review",
      fields: { status: "running", reviewState: "acknowledged" },
      updatedAt: new Date("2026-07-12T00:04:00Z"),
    });
    await expect(sessionMutations.reconcileNodeDisconnected(
      "node-review",
      new Date("2026-07-12T00:05:00Z"),
      "node_disconnect",
    )).resolves.toMatchObject({
      interrupted: 1,
      updates: [
        expect.objectContaining({
          sessionId: "sess-review",
          status: "interrupted",
          terminationDetail: "node_disconnect",
          reviewState: "needs_review",
        }),
      ],
    });

    await expect(db.getSession("sess-review")).resolves.toMatchObject({
      status: "interrupted",
      review_required: true,
      review_state: "needs_review",
    });
  }, 30_000);

  it("reprojects response-loss binding warnings from durable state after restart", async () => {
    const now = new Date("2026-07-13T00:00:00Z");
    await sessionMutations.registerSession({
      idempotencyKey: "register:sess-response-lost",
      sessionId: "sess-response-lost",
      nodeId: "node-review",
      agentId: "codex-default",
      claudeSessionId: null,
      sessionType: "claude",
      prompt: "recover me",
      clientId: null,
      status: "running",
      createdAt: now,
      updatedAt: now,
      callerSessionId: null,
      predecessorSessionId: null,
      reviewRequired: true,
      reviewState: "needs_review",
    });
    await db.sessionPageBindings().enqueue({
      sessionId: "sess-response-lost",
      nodeId: "node-review",
      targetPageId: "page-target",
      targetBlockId: "block-target",
      targetExpectedVersion: 7,
      initialPageState: "pending",
      dailyDate: "2026-07-13",
      sessionType: "claude",
      legacyFolderId: null,
      legacyContainerKind: null,
      legacyContainerId: null,
      sourceTaskItemId: null,
    });
    await harness!.sql`
      UPDATE session_page_bindings
      SET page_state = 'manual_repair', legacy_state = 'pending'
      WHERE session_id = 'sess-response-lost'
    `;

    const restarted = new SessionDB();
    configureTestSessionDataHost(restarted, harness!.sql);
    restarted.configureSessionPageBindingHost(
      new SessionPageBindingRepository(harness!.sql) as never,
    );
    const responseLostRead = await restarted.listSessionsForUpstreamDump({
      limit: 10,
      offset: 0,
      nodeId: "node-review",
    });
    expect(responseLostRead.sessions.find(
      (session) => session.session_id === "sess-response-lost",
    )).toMatchObject({
      session_id: "sess-response-lost",
      review_required: true,
      review_state: "needs_review",
      binding_warnings: [
        { code: "PAGE_BINDING_MANUAL_REPAIR" },
        { code: "LEGACY_PROJECTION_PENDING" },
      ],
    });

    await harness!.sql`
      UPDATE session_page_bindings
      SET page_state = 'bound', legacy_state = 'completed'
      WHERE session_id = 'sess-response-lost'
    `;
    const replayed = await restarted.listSessionsForUpstreamDump({
      limit: 10,
      offset: 0,
      nodeId: "node-review",
    });
    expect(replayed.sessions.find(
      (session) => session.session_id === "sess-response-lost",
    )).toMatchObject({ binding_warnings: [] });
  }, 30_000);

});

function hasDockerBinary(): boolean {
  const result = spawnSync("docker", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

interface PostgresHarness {
  sql: SqlClient;
  cleanup(): Promise<void>;
}

async function createHarness(): Promise<PostgresHarness> {
  const externalUrl = process.env.TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    await assertSafeExternalDatabase(externalUrl);
    return await connect(externalUrl, undefined);
  }

  const containerId = execFileSync("docker", [
    "run",
    "--rm",
    "-d",
    "-e",
    `POSTGRES_USER=${TEST_USER}`,
    "-e",
    `POSTGRES_PASSWORD=${TEST_PASSWORD}`,
    "-e",
    `POSTGRES_DB=${TEST_DB_NAME}`,
    "-p",
    "127.0.0.1::5432",
    "postgres:16-alpine",
  ], { encoding: "utf8" }).trim();

  try {
    const port = dockerMappedPort(containerId);
    return await connect(
      `postgres://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${port}/${TEST_DB_NAME}`,
      containerId,
    );
  } catch (err) {
    stopDocker(containerId);
    throw err;
  }
}

async function connect(url: string, containerId: string | undefined): Promise<PostgresHarness> {
  const schema = `session_db_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const sql = postgres(url, { max: 1, idle_timeout: 1 }) as SqlClient;
  await waitForPostgres(sql);
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(`SET search_path TO ${schema}`);

  return {
    sql,
    async cleanup() {
      try {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await sql.end({ timeout: 5 });
        if (containerId) stopDocker(containerId);
      }
    },
  };
}

async function applyCurrentSchema(sql: SqlClient): Promise<void> {
  const schemaSql = readFileSync(
    fileURLToPath(new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url)),
    "utf8",
  );
  await sql.unsafe(schemaSql);
}

async function assertSafeExternalDatabase(url: string): Promise<void> {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, "").toLowerCase();
  const full = `${parsed.hostname}/${name}`.toLowerCase();
  const banned = ["atom_db", "reverie", "soulstream", "serendipity"];
  if (!name.includes("test")) {
    throw new Error("TEST_DATABASE_URL database name must include 'test'");
  }
  if (banned.some((token) => full.includes(token))) {
    throw new Error("TEST_DATABASE_URL points at a protected database name");
  }

  const sql = postgres(url, { max: 1, idle_timeout: 1 }) as SqlClient;
  try {
    const rows = await sql<Array<{ count: string | number }>>`
      SELECT COUNT(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    `;
    if (Number(rows[0]?.count ?? 0) > 0) {
      throw new Error("TEST_DATABASE_URL must point at an empty test database");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function waitForPostgres(sql: SqlClient): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function dockerMappedPort(containerId: string): string {
  for (let i = 0; i < 30; i += 1) {
    const output = execFileSync("docker", ["port", containerId, "5432/tcp"], {
      encoding: "utf8",
    }).trim();
    const match = output.match(/:(\d+)$/);
    if (match) return match[1];
  }
  throw new Error("docker did not publish a PostgreSQL port");
}

function stopDocker(containerId: string): void {
  execFileSync("docker", ["stop", containerId], { stdio: "ignore" });
}

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import { startPostgresTestContainer } from
  "../../packages/db-schema/scripts/postgres-test-container.mjs";
import { createLiveCogitoSearchProvider } from
  "../src/runtime/live_cogito_search_provider.js";
import {
  cancelLiveSearchQuerySafely,
  createLiveSearchDbConnectionFactory,
  type LiveSearchPendingQuery,
} from
  "../src/runtime/live_db_sql.js";

const hasDocker = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const describePostgres = hasDocker ? describe : describe.skip;

describePostgres("session search reliability PostgreSQL integration", () => {
  let sql: ReturnType<typeof postgres>;
  let databaseUrl: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ sql, databaseUrl, cleanup } = await createHarness());
    await seedSearchFixtures(sql);
  }, 60_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("keeps exact defaults and independently recalls prefix candidates under folder scope", async () => {
    const exact = await sql`
      SELECT session_id FROM event_search(
        ${"commonphrase"}, NULL, 2, ARRAY['assistant_message']::text[],
        ARRAY['folder-allowed']::text[]
      )
    `;
    expect(new Set(exact.map((row) => row.session_id))).toEqual(new Set(["popular"]));

    const legacyPrefix = await sql`
      SELECT session_id FROM event_search(
        ${"업무 검색어"}, NULL, 2, ARRAY['assistant_message']::text[],
        ARRAY['folder-allowed']::text[]
      )
    `;
    expect(legacyPrefix.map((row) => row.session_id)).not.toContain("prefix-target");

    const independentPrefix = await sql`
      SELECT session_id FROM event_search(
        ${"업무 검색어"}, NULL, 2, ARRAY['assistant_message']::text[],
        ARRAY['folder-allowed']::text[], 1, 2
      )
    `;
    expect(independentPrefix.map((row) => row.session_id)).toContain("prefix-target");

    const denied = await sql`
      SELECT session_id FROM event_search(
        ${"secretphrase"}, NULL, 5, ARRAY['assistant_message']::text[],
        ARRAY['folder-allowed']::text[]
      )
    `;
    expect(denied).toHaveLength(0);
  });

  it("projects the authorized primary task membership for a real session search", async () => {
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: createLiveSearchDbConnectionFactory({ databaseUrl }),
    });
    const response = await provider.search({
      q: "task result",
      top_k: 20,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      allowedFolderIds: ["folder-allowed"],
    });

    expect(response.session_results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        session_id: "task-session",
        task_id: "task-primary",
        task_title: "Search task result",
      }),
    ]));
    expect(response.session_results?.map((row) => row.session_id)).not.toContain("denied-session");
  });

  it("keeps per-session product candidates when global top events repeat one session", async () => {
    await sql`INSERT INTO sessions (session_id, folder_id, display_name, status, session_type)
      VALUES ('crowded-session', 'folder-allowed', 'Crowded session', 'idle', 'claude'),
             ('distinct-session', 'folder-allowed', 'Distinct session', 'idle', 'claude')`;
    for (let id = 1; id <= 8; id += 1) {
      await sql`
        INSERT INTO events (session_id, id, event_type, searchable_text, created_at)
        VALUES ('crowded-session', ${id}, 'assistant_message', 'search crowd distinct work',
          ${new Date(Date.now() + id * 1_000)})
      `;
    }
    await sql`
      INSERT INTO events (session_id, id, event_type, searchable_text, created_at)
      VALUES ('distinct-session', 1, 'assistant_message', 'search crowd distinct work',
        ${new Date(Date.now() - 3_600_000)})
    `;

    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: createLiveSearchDbConnectionFactory({ databaseUrl }),
    });
    const response = await provider.search({
      q: "search crowd distinct work",
      top_k: 1,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      allowedFolderIds: ["folder-allowed"],
    });

    expect(response.results.slice(0, 1)).toHaveLength(1);
    expect(response.results[0]?.session_id).toBe("crowded-session");
    expect(response.session_results?.map((result) => result.session_id))
      .toContain("distinct-session");
  });

  it("cancels only the owned active search connection and closes completed requests safely", async () => {
    const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const factory = createLiveSearchDbConnectionFactory({ databaseUrl });
    try {
      const activeConnection = await factory.open(10_000);
      const activePidRows = await activeConnection.sql`SELECT pg_backend_pid() AS pid`;
      const pid = Number(activePidRows[0]?.pid);
      const startedAt = Date.now();
      const pending = activeConnection.sql`SELECT pg_sleep(10) /* SEARCH_CANCEL_ACTIVE_TEST */`;
      const pendingSettlement = settleWithin(pending, 2_500);
      await waitForActiveQuery(admin, Number(pid));
      await expect(admin`SELECT 1 AS value`).resolves.toEqual([{ value: 1 }]);

      let cancellationError: unknown;
      const cancelled = cancelLiveSearchQuerySafely(
        pending as unknown as LiveSearchPendingQuery<readonly Record<string, unknown>[]>,
        (error) => { cancellationError = error; },
      );
      expect(cancelled).toBe(true);
      await pendingSettlement;
      expect(cancellationError).toBeUndefined();
      await activeConnection.close();
      await expectNoBackend(admin, Number(pid));
      const activeCancelMs = Date.now() - startedAt;

      const completedConnection = await factory.open(10_000);
      const completedPidRows = await completedConnection.sql`
        SELECT pg_backend_pid() AS "completedPid"
      `;
      const completedPid = Number(completedPidRows[0]?.completedPid);
      const completed = completedConnection.sql`SELECT 1 AS value /* SEARCH_CANCEL_COMPLETE_TEST */`;
      await expect(completed).resolves.toEqual([{ value: 1 }]);
      const completedCancelled = cancelLiveSearchQuerySafely(
        completed as unknown as LiveSearchPendingQuery<readonly Record<string, unknown>[]>,
        () => undefined,
      );
      expect(typeof completedCancelled).toBe("boolean");
      await expect(completedConnection.sql`SELECT 2 AS value`).resolves.toEqual([{ value: 2 }]);
      await completedConnection.close();
      await expectNoBackend(admin, Number(completedPid));
      await expect(admin`SELECT 3 AS value`).resolves.toEqual([{ value: 3 }]);
      expect(activeCancelMs).toBeLessThan(2_500);
    } finally {
      await admin.end({ timeout: 2 });
    }
  }, 15_000);

  it("applies a remaining-deadline statement timeout and discards a hung owned connection", async () => {
    const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const factory = createLiveSearchDbConnectionFactory({ databaseUrl });
    try {
      const timeoutConnection = await factory.open(10_000);
      const pidRows = await timeoutConnection.sql`SELECT pg_backend_pid() AS pid`;
      const pid = Number(pidRows[0]?.pid);
      await timeoutConnection.sql.setStatementTimeout?.(100);
      await expect(timeoutConnection.sql`SELECT pg_sleep(10) /* SEARCH_DEADLINE_TIMEOUT_TEST */`)
        .rejects.toMatchObject({ code: "57014" });
      await expect(timeoutConnection.sql`SELECT 2 AS value`).resolves.toEqual([{ value: 2 }]);
      await expect(admin`SELECT 3 AS value`).resolves.toEqual([{ value: 3 }]);
      await timeoutConnection.close();
      await expectNoBackend(admin, pid);

      const discardedConnection = await factory.open(10_000);
      const discardedPidRows = await discardedConnection.sql`
        SELECT pg_backend_pid() AS pid
      `;
      const discardedPid = Number(discardedPidRows[0]?.pid);
      await discardedConnection.sql.setStatementTimeout?.(100);
      const pending = discardedConnection.sql`SELECT pg_sleep(10) /* SEARCH_DISCARD_HUNG_TEST */`;
      const pendingSettlement = settleWithin(pending, 2_500);
      await waitForActiveQuery(admin, discardedPid);
      await discardedConnection.discard?.();
      await pendingSettlement;
      await expect(admin`SELECT 4 AS value`).resolves.toEqual([{ value: 4 }]);
      await waitForNoBackend(admin, discardedPid);
    } finally {
      await admin.end({ timeout: 2 });
    }
  }, 15_000);
});

async function createHarness(): Promise<{
  sql: ReturnType<typeof postgres>;
  databaseUrl: string;
  cleanup: () => Promise<void>;
}> {
  const container = startPostgresTestContainer({
    user: "session_search_test",
    password: "session_search_test",
    database: "session_search_test_db",
  });
  const databaseUrl =
    `postgres://session_search_test:session_search_test@127.0.0.1:${container.port}/session_search_test_db`;
  const bootstrap = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await waitForPostgres(bootstrap);
    const schema = readFileSync(fileURLToPath(new URL(
      "../../packages/db-schema/sql/schema.sql",
      import.meta.url,
    )), "utf8");
    const migration = readFileSync(fileURLToPath(new URL(
      "../../packages/db-schema/sql/migrations/096_session_search_reliability.sql",
      import.meta.url,
    )), "utf8");
    await bootstrap.unsafe(schema);
    await bootstrap.unsafe(migration);
  } catch (error) {
    await bootstrap.end({ timeout: 2 }).catch(() => undefined);
    container.stop();
    throw error;
  }
  return {
    sql: bootstrap,
    databaseUrl,
    cleanup: async () => {
      await bootstrap.end({ timeout: 2 });
      container.stop();
    },
  };
}

async function waitForPostgres(sql: ReturnType<typeof postgres>): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError ?? new Error("PostgreSQL did not become ready");
}

async function seedSearchFixtures(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`INSERT INTO folders (id, name) VALUES ('folder-allowed', 'Allowed')`;
  await sql`INSERT INTO folders (id, name) VALUES ('folder-denied', 'Denied')`;
  const sessions = [
    "popular",
    "exact-other",
    "prefix-fill-a",
    "prefix-fill-b",
    "prefix-target",
    "task-session",
    "denied-session",
  ];
  for (const sessionId of sessions) {
    const folderId = sessionId === "denied-session" ? "folder-denied" : "folder-allowed";
    await sql`
      INSERT INTO sessions (session_id, folder_id, display_name, status, session_type)
      VALUES (${sessionId}, ${folderId}, ${sessionId}, 'idle', 'claude')
    `;
  }

  for (let id = 1; id <= 5; id += 1) {
    await sql`
      INSERT INTO events (session_id, id, event_type, searchable_text, created_at)
      VALUES ('popular', ${id}, 'assistant_message',
        'commonphrase commonphrase commonphrase popular record',
        ${new Date(Date.now() + id * 1_000)})
    `;
  }
  await insertEvent(sql, "exact-other", 1, "commonphrase alternate result");
  await insertEvent(sql, "prefix-fill-a", 1, "업무 업무 업무 진행 분석");
  await insertEvent(sql, "prefix-fill-b", 1, "업무 업무 업무 설계 진행");
  await insertEvent(sql, "prefix-target", 1, "업무 검색어자동화 결과 확인");
  await insertEvent(sql, "task-session", 1, "task result confirmation from session");
  await insertEvent(sql, "denied-session", 1, "secretphrase restricted result");

  await sql`
    INSERT INTO board_items (
      id, folder_id, container_kind, container_id, membership_kind, item_type, item_id
    ) VALUES (
      'task-board-item', 'folder-allowed', 'folder', 'folder-allowed',
      'primary', 'task', 'task-primary'
    )
  `;
  await sql`
    INSERT INTO tasks (id, board_item_id, title)
    VALUES ('task-primary', 'task-board-item', 'Search task result')
  `;
  await sql`
    INSERT INTO board_items (
      id, folder_id, container_kind, container_id, membership_kind, item_type, item_id
    ) VALUES (
      'task-session-membership', 'folder-allowed', 'task', 'task-primary',
      'primary', 'session', 'task-session'
    )
  `;
}

async function insertEvent(
  sql: ReturnType<typeof postgres>,
  sessionId: string,
  id: number,
  searchableText: string,
): Promise<void> {
  await sql`
    INSERT INTO events (session_id, id, event_type, searchable_text)
    VALUES (${sessionId}, ${id}, 'assistant_message', ${searchableText})
  `;
}

async function waitForActiveQuery(
  sql: ReturnType<typeof postgres>,
  pid: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const active = await sql`
      SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid = ${pid}
        AND state = 'active'
    `;
    if (active.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`PostgreSQL did not report backend ${pid} active`);
}

async function expectNoBackend(
  sql: ReturnType<typeof postgres>,
  pid: number,
): Promise<void> {
  const active = await sql`
    SELECT 1 FROM pg_stat_activity
    WHERE datname = current_database()
        AND pid = ${pid}
  `;
  expect(active).toHaveLength(0);
}

async function waitForNoBackend(
  sql: ReturnType<typeof postgres>,
  pid: number,
  timeoutMs = 2_500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = await sql`
      SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid = ${pid}
    `;
    if (active.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("discarded search backend did not exit after statement_timeout");
}

async function settleWithin(
  query: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      query.then(() => undefined, () => undefined),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("PostgreSQL cancel did not settle")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import { startPostgresTestContainer } from
  "../../packages/db-schema/scripts/postgres-test-container.mjs";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { EventReadRepository } from "../src/control_plane/repositories/event_read_repository.js";
import { SessionHistorySearchRepository } from "../src/control_plane/repositories/session_history_search_repository.js";
import { SessionStoryReadRepository } from "../src/control_plane/repositories/session_story_read_repository.js";
import { createLiveCogitoSearchProvider } from
  "../src/runtime/live_cogito_search_provider.js";
import {
  cancelLiveSearchQuerySafely,
  createLiveSearchDbConnectionFactory,
  type LiveSearchPendingQuery,
  type LiveSearchSql,
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

  it("does not convert a non-product provider deadline into empty search success", async () => {
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: {
        open: async () => { throw new Error("an expired request must not open a connection"); },
      },
    });

    await expect(provider.search({
      q: "deadline query",
      top_k: 10,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      deadlineAt: Date.now() - 100,
    })).rejects.toMatchObject({ statusCode: 504 });
  });

  it("rebuilds compact session indexes for long existing keys and keeps long searches writable", async () => {
    const migration = readFileSync(fileURLToPath(new URL(
      "../../packages/db-schema/sql/migrations/097_session_search_reliability.sql",
      import.meta.url,
    )), "utf8");
    const existingPrompt = longMixedText("기존요청문검색표적", 5_000, 17);
    const existingTitle = longMixedText("기존제목검색표적", 5_000, 29);
    const insertedTitle = longMixedText("신규제목검색표적", 5_000, 43);
    const insertedPrompt = longMixedText("신규요청검색표적", 5_000, 59);
    const updatedTitle = longMixedText("수정제목검색표적", 5_000, 71);
    const updatedPrompt = longMixedText("수정요청검색표적", 5_000, 83);

    await sql.begin(async (tx) => {
      await tx`DROP INDEX idx_sessions_display_name_search_key`;
      await tx`DROP INDEX idx_sessions_prompt_search_key`;
      await tx`
        INSERT INTO sessions (session_id, folder_id, display_name, prompt, node_id, status)
        VALUES (
          'long-prompt-before-migration', 'folder-allowed', 'short prompt fixture',
          ${existingPrompt}, 'fixture-node', 'completed'
        )
      `;
      await tx.unsafe(migration);
    });

    const existingPromptChars = Array.from(existingPrompt);
    const prefixCollisionPrompt = [
      ...existingPromptChars.slice(0, 512),
      existingPromptChars[512] === "가" ? "나" : "가",
      ...existingPromptChars.slice(513),
    ].join("");
    await sql`
      INSERT INTO sessions (session_id, folder_id, display_name, prompt, node_id, status)
      VALUES (
        'long-prompt-prefix-collision', 'folder-allowed', 'prefix collision fixture',
        ${prefixCollisionPrompt}, 'fixture-node', 'completed'
      )
    `;

    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: createLiveSearchDbConnectionFactory({ databaseUrl }),
    });
    const searchSessions = async (query: string) => provider.search({
      q: query,
      top_k: 10,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      allowedFolderIds: ["folder-allowed"],
    });

    const promptHit = await searchSessions("기존요청문검색표적");
    expect(promptHit.session_results?.map((row) => row.session_id))
      .toContain("long-prompt-before-migration");
    for (const queryLength of [511, 512]) {
      const boundaryHits = await searchSessions(existingPromptChars.slice(0, queryLength).join(""));
      expect(boundaryHits.session_results?.map((row) => row.session_id)).toEqual(
        expect.arrayContaining(["long-prompt-before-migration", "long-prompt-prefix-collision"]),
      );
    }
    for (const queryLength of [513, 700]) {
      const longQueryHits = await searchSessions(existingPromptChars.slice(0, queryLength).join(""));
      expect(longQueryHits.session_results?.map((row) => row.session_id)).toContain(
        "long-prompt-before-migration",
      );
      expect(longQueryHits.session_results?.map((row) => row.session_id)).not.toContain(
        "long-prompt-prefix-collision",
      );
    }
    await sql`SET enable_seqscan = off`;
    const promptPlan = await sql`
      EXPLAIN SELECT session_id FROM sessions
      WHERE session_search_index_prefix(prompt_search_key)
        LIKE session_search_index_prefix(session_search_compact(${"기존요청문검색표적"})) || '%'
        AND prompt_search_key LIKE session_search_compact(${"기존요청문검색표적"}) || '%'
    `;
    await sql`RESET enable_seqscan`;
    expect(promptPlan.map((row) => JSON.stringify(row)).join("\n"))
      .toContain("idx_sessions_prompt_search_key");
    const prefixSize = await sql`
      SELECT octet_length(session_search_index_prefix(prompt_search_key)) AS size
      FROM sessions WHERE session_id = 'long-prompt-before-migration'
    `;
    expect(Number(prefixSize[0]?.size)).toBeLessThanOrEqual(2_048);
    expect((await sql`
      SELECT prompt FROM sessions WHERE session_id = 'long-prompt-before-migration'
    `)[0]?.prompt).toBe(existingPrompt);

    await sql.begin(async (tx) => {
      await tx`DROP INDEX idx_sessions_display_name_search_key`;
      await tx`
        INSERT INTO sessions (session_id, folder_id, display_name, prompt, node_id, status)
        VALUES (
          'long-title-before-migration', 'folder-allowed', ${existingTitle},
          'short title fixture', 'fixture-node', 'completed'
        )
      `;
      await tx.unsafe(migration);
    });

    const titleHit = await searchSessions("기존제목검색표적");
    expect(titleHit.session_results?.map((row) => row.session_id))
      .toContain("long-title-before-migration");
    expect((await sql`
      SELECT display_name FROM sessions WHERE session_id = 'long-title-before-migration'
    `)[0]?.display_name).toBe(existingTitle);

    await sql`
      INSERT INTO sessions (session_id, folder_id, display_name, prompt, node_id, status)
      VALUES (
        'long-session-after-migration', 'folder-allowed', ${insertedTitle},
        ${insertedPrompt}, 'fixture-node', 'completed'
      )
    `;
    await sql`
      UPDATE sessions SET display_name = ${updatedTitle}, prompt = ${updatedPrompt}
      WHERE session_id = 'long-session-after-migration'
    `;

    const updatedTitleHit = await searchSessions("수정제목검색표적");
    expect(updatedTitleHit.session_results?.map((row) => row.session_id))
      .toContain("long-session-after-migration");
    const updatedPromptHit = await searchSessions("수정요청검색표적");
    expect(updatedPromptHit.session_results?.map((row) => row.session_id))
      .toContain("long-session-after-migration");
    expect((await sql`
      SELECT display_name, prompt FROM sessions WHERE session_id = 'long-session-after-migration'
    `)[0]).toMatchObject({ display_name: updatedTitle, prompt: updatedPrompt });
  }, 30_000);

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
    expect(response.session_results?.find((row) => row.session_id === "task-session"))
      .toMatchObject({ parent_session_id: "caller-parent" });
  });

  it("uses caller plus primary task membership and ranks verified work over an equal re-quote", async () => {
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: createLiveSearchDbConnectionFactory({ databaseUrl }),
    });
    const execution = await provider.search({
      q: "unique execution phrase",
      top_k: 10,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      allowedFolderIds: ["folder-allowed"],
    });

    expect(execution.session_results?.slice(0, 2).map((row) => row.session_id)).toEqual([
      "actual-work-session",
      "diagnostic-session",
    ]);
    expect(execution.session_results?.[0]).toMatchObject({
      task_id: "task-primary",
      parent_session_id: "caller-parent",
    });
    expect(execution.session_results?.[0]?.evidence).toContainEqual(expect.objectContaining({
      source: "task_item_completed",
      excerpt: "Unique execution verification",
    }));
    expect(execution.session_results?.[1]?.parent_session_id).toBeNull();
    expect(execution.session_results?.[1]?.task_id).toBeNull();

    const taskTitleSearch = await provider.search({
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
    for (const sessionId of ["referenced-session", "metadata-only-session"]) {
      expect(taskTitleSearch.session_results?.find((row) => row.session_id === sessionId)?.task_id)
        .toBeNull();
    }

    const outputSearch = await provider.search({
      q: "output artifact marker",
      top_k: 10,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      allowedFolderIds: ["folder-allowed"],
    });
    expect(outputSearch.session_results?.find((row) => row.session_id === "source-item-session")?.evidence)
      .toContainEqual(expect.objectContaining({ source: "source_task_item" }));
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

  it("applies every session filter before source limits and preserves the inclusive date boundary", async () => {
    const cutoff = new Date("2026-08-01T00:00:00.000Z");
    await sql`
      INSERT INTO sessions (
        session_id, folder_id, display_name, prompt, node_id, status,
        agent_id, model_preset, updated_at, session_type
      ) VALUES (
        'filter-target', 'folder-allowed', 'FilterPhrase target', 'FilterPhrase initial request',
        'filter-node', 'completed', 'agent-codex', 'codex-preset', ${cutoff}, 'claude'
      )
    `;
    const filterFailures: Array<{
      sessionId: string;
      folder_id?: string;
      node_id?: string;
      status?: string;
      model_preset?: string;
      updated_at?: Date | null;
    }> = [
      { sessionId: "filter-wrong-status", status: "idle" },
      { sessionId: "filter-wrong-node", node_id: "other-node" },
      { sessionId: "filter-wrong-backend", model_preset: "claude-preset" },
      { sessionId: "filter-wrong-folder", folder_id: "folder-denied" },
      { sessionId: "filter-before-cutoff", updated_at: new Date("2026-07-31T23:59:59.999Z") },
      { sessionId: "filter-null-updated", updated_at: null },
    ];
    for (const { sessionId, ...overrides } of filterFailures) {
      await sql`
        INSERT INTO sessions (
          session_id, folder_id, display_name, prompt, node_id, status,
          agent_id, model_preset, updated_at, session_type
        ) VALUES (
          ${sessionId},
          ${overrides.folder_id ?? "folder-allowed"},
          'FilterPhrase target', 'FilterPhrase initial request',
          ${overrides.node_id ?? "filter-node"},
          ${overrides.status ?? "completed"},
          'agent-codex',
          ${overrides.model_preset ?? "codex-preset"},
          ${overrides.updated_at === undefined ? cutoff : overrides.updated_at},
          'claude'
        )
      `;
    }

    for (const sessionId of [
      "filter-target",
      "filter-wrong-status",
      "filter-wrong-node",
      "filter-wrong-backend",
      "filter-wrong-folder",
      "filter-before-cutoff",
      "filter-null-updated",
    ]) {
      await sql`
        INSERT INTO events (session_id, id, event_type, searchable_text, created_at)
        VALUES (
          ${sessionId}, 1, 'user_message',
          ${sessionId === "filter-target"
            ? "FilterPhrase was the initial request"
            : "FilterPhrase filterphrase filterphrase filterphrase filterphrase filterphrase"},
          ${cutoff}
        )
      `;
      await sql`
        INSERT INTO session_digests (
          session_id, narrative, highlight, narrative_through_event_id
        ) VALUES (
          ${sessionId}, 'FilterPhrase narrative', 'FilterPhrase highlight', 1
        )
      `;
    }

    const unfilteredEventIds = await sql`
      SELECT session_id FROM event_search(
        ${"filterphrase"}, NULL, 5, ARRAY['user_message']::text[],
        ARRAY['folder-allowed', 'folder-denied']::text[]
      )
    `;
    expect(unfilteredEventIds.map((row) => row.session_id)).not.toContain("filter-target");

    const backendCatalog = [
      { kind: "preset", node_id: "filter-node", model_preset: "codex-preset", backend: "codex" },
      { kind: "preset", node_id: "filter-node", model_preset: "claude-preset", backend: "claude" },
      { kind: "agent", node_id: "filter-node", agent_id: "agent-codex", backend: "claude" },
    ] as const;
    const catalogKind = await sql`
      SELECT jsonb_typeof(${JSON.stringify(backendCatalog)}::text::jsonb) AS kind
    `;
    expect(catalogKind[0]?.kind).toBe("array");
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: createLiveSearchDbConnectionFactory({ databaseUrl }),
      sessionBackendCatalog: () => backendCatalog,
    });
    const response = await provider.search({
      q: "filterphrase",
      top_k: 1,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: true,
      include_story: true,
      include_session_results: true,
      session_search_mode: "lexical",
      allowedFolderIds: ["folder-allowed", "folder-denied"],
      session_filters: {
        folder_id: "folder-allowed",
        node_id: "filter-node",
        statuses: ["completed"],
        backends: ["codex"],
        updated_after: cutoff.toISOString(),
      },
    });

    expect(response.session_results?.map((result) => result.session_id)).toEqual(["filter-target"]);
    expect(response.session_results?.[0]).toMatchObject({
      session_id: "filter-target",
      folder_id: "folder-allowed",
      node_id: "filter-node",
      status: "completed",
      backend: "codex",
    });

    const emptyIntersection = await provider.search({
      q: "filterphrase",
      top_k: 1,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: true,
      include_story: true,
      include_session_results: true,
      session_search_mode: "lexical",
      allowedFolderIds: ["folder-allowed"],
      session_filters: { folder_id: "folder-denied" },
    });
    expect(emptyIntersection.session_results).toEqual([]);

    const metadataFilters = sql.json({
      folder_id: "folder-allowed",
      node_id: "filter-node",
      status: ["completed"],
      updated_after: cutoff.toISOString(),
      backends: ["codex"],
      backend_catalog: backendCatalog,
    });
    const metadataMatches = await sql`
      SELECT session_id FROM session_get_all(${metadataFilters}::jsonb, 50, 0)
      WHERE session_id LIKE 'filter-%'
      ORDER BY session_id
    `;
    expect(metadataMatches.map((row) => row.session_id)).toEqual(["filter-target"]);
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

  it("cancels an event_search request and leaves no database query after caller abort", async () => {
    const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const factory = createLiveSearchDbConnectionFactory({
      databaseUrl,
      postgresFactory: (url, options) => {
        const client = postgres(url, { ...options, onnotice: () => {} });
        const instrumented = ((strings: TemplateStringsArray, ...values: unknown[]) => {
          if (strings.join("").includes("FROM event_search(")) {
            return client`SELECT pg_sleep(10) /* SEARCH_HOST_EVENT_CANCEL_TEST */`;
          }
          const query = strings.reduce((text, part, index) =>
            `${text}${index === 0 ? "" : `$${index}`}${part}`, "");
          return client.unsafe(query, values as never[]);
        }) as unknown as LiveSearchSql;
        Object.assign(instrumented, {
          end: (closeOptions?: { readonly timeout?: number }) => client.end(closeOptions),
        });
        return instrumented;
      },
    });
    const repository = new EventReadRepository(admin as unknown as SqlClient, factory);
    const controller = new AbortController();
    try {
      const pending = repository.searchEvents(
        "slow host search",
        null,
        10,
        null,
        controller.signal,
      );
      const pid = await waitForActiveSearch(admin, "SEARCH_HOST_EVENT_CANCEL_TEST");
      controller.abort(new Error("MCP caller timed out"));
      await expect(pending).rejects.toThrow("MCP caller timed out");
      await expectNoBackend(admin, pid);
      await expect(admin`SELECT 1 AS value`).resolves.toEqual([{ value: 1 }]);
    } finally {
      await admin.end({ timeout: 2 });
    }
  }, 12_000);

  it("cancels the combined MCP history-search request and leaves no database backend", async () => {
    const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const factory = createLiveSearchDbConnectionFactory({
      databaseUrl,
      postgresFactory: (url, options) => {
        const client = postgres(url, { ...options, onnotice: () => {} });
        const instrumented = ((strings: TemplateStringsArray, ...values: unknown[]) => {
          if (strings.join("").includes("FROM event_search(")) {
            return client`SELECT pg_sleep(10) /* HISTORY_SEARCH_CANCEL_TEST */`;
          }
          const query = strings.reduce((text, part, index) =>
            `${text}${index === 0 ? "" : `$${index}`}${part}`, "");
          return client.unsafe(query, values as never[]);
        }) as unknown as LiveSearchSql;
        Object.assign(instrumented, {
          end: (closeOptions?: { readonly timeout?: number }) => client.end(closeOptions),
        });
        return instrumented;
      },
    });
    const repository = new SessionHistorySearchRepository(
      factory,
      new EventReadRepository(admin as unknown as SqlClient),
      new SessionStoryReadRepository(admin as unknown as SqlClient),
    );
    const controller = new AbortController();
    try {
      const pending = repository.search({
        query: "slow history search",
        sessionIds: null,
        limit: 10,
        eventTypes: null,
        searchSessionId: true,
        includeHighlight: true,
        includeStory: true,
      }, controller.signal);
      const pid = await waitForActiveSearch(admin, "HISTORY_SEARCH_CANCEL_TEST");
      controller.abort(new Error("MCP session-data caller timed out"));

      await expect(pending).rejects.toThrow("MCP session-data caller timed out");
      await expectNoBackend(admin, pid);
      await expect(admin`SELECT 1 AS value`).resolves.toEqual([{ value: 1 }]);
    } finally {
      await admin.end({ timeout: 2 });
    }
  }, 12_000);

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

  it("cancels request-owned digest search after caller abort", async () => {
    const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const factory = createLiveSearchDbConnectionFactory({
      databaseUrl,
      postgresFactory: (url, options) => {
        const client = postgres(url, { ...options, onnotice: () => {} });
        const instrumented = ((strings: TemplateStringsArray, ...values: unknown[]) => {
          if (strings.join("").includes("FROM session_digests d")) {
            return client`SELECT pg_sleep(10) /* SEARCH_HOST_DIGEST_CANCEL_TEST */`;
          }
          const query = strings.reduce((text, part, index) =>
            `${text}${index === 0 ? "" : `$${index}`}${part}`, "");
          return client.unsafe(query, values as never[]);
        }) as unknown as LiveSearchSql;
        Object.assign(instrumented, {
          end: (closeOptions?: { readonly timeout?: number }) => client.end(closeOptions),
        });
        return instrumented;
      },
    });
    const repository = new SessionStoryReadRepository(admin as unknown as SqlClient, factory);
    const controller = new AbortController();
    try {
      const pending = repository.searchSessionDigests(
        "needle",
        null,
        10,
        true,
        true,
        controller.signal,
      );
      const pid = await waitForActiveSearch(admin, "SEARCH_HOST_DIGEST_CANCEL_TEST");
      await expect(admin`SELECT 1 AS value`).resolves.toEqual([{ value: 1 }]);
      controller.abort(new Error("caller disconnected"));
      await settleWithin(pending, 2_500);
      await expectNoBackend(admin, pid);
      await expect(admin`SELECT 2 AS value`).resolves.toEqual([{ value: 2 }]);
    } finally {
      await admin.end({ timeout: 2 });
    }
  }, 15_000);

  it("uses one owned connection for event, session-id, and digest sources", async () => {
    let connectionCount = 0;
    const queryTexts: string[] = [];
    const factory = createLiveSearchDbConnectionFactory({
      databaseUrl,
      postgresFactory: (url, options) => {
        connectionCount += 1;
        const client = postgres(url, { ...options, onnotice: () => {} });
        const instrumented = ((strings: TemplateStringsArray, ...values: unknown[]) => {
          queryTexts.push(strings.join(""));
          return client(strings, ...values as never[]);
        }) as unknown as LiveSearchSql;
        Object.assign(instrumented, {
          end: (closeOptions?: { readonly timeout?: number }) => client.end(closeOptions),
        });
        return instrumented;
      },
    });
    const repository = new SessionHistorySearchRepository(
      factory,
      new EventReadRepository(sql as unknown as SqlClient),
      new SessionStoryReadRepository(sql as unknown as SqlClient),
    );

    const result = await repository.search({
      query: "needle",
      sessionIds: null,
      limit: 10,
      eventTypes: ["assistant_message"],
      searchSessionId: true,
      includeHighlight: true,
      includeStory: true,
    }, new AbortController().signal);

    expect(result).toMatchObject({ events: [], sessionIdEvents: [], digests: [] });
    expect(connectionCount).toBe(1);
    expect(queryTexts.some((text) => text.includes("FROM event_search("))).toBe(true);
    expect(queryTexts.some((text) => text.includes("FROM session_id_search("))).toBe(true);
    expect(queryTexts.some((text) => text.includes("FROM session_digests d"))).toBe(true);
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
      "../../packages/db-schema/sql/migrations/097_session_search_reliability.sql",
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

function longMixedText(prefix: string, length: number, seed: number): string {
  const alphabet = Array.from("가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz");
  const chars = new Array<string>(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    chars[index] = alphabet[state % alphabet.length] ?? "가";
  }
  return `${prefix}${chars.join("")}`;
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
    "caller-parent",
    "predecessor-only",
    "referenced-session",
    "metadata-only-session",
    "actual-work-session",
    "diagnostic-session",
    "source-item-session",
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
  await insertEvent(sql, "referenced-session", 1, "task result discussion only");
  await insertEvent(sql, "metadata-only-session", 1, "task result edit history only");
  await insertEvent(sql, "actual-work-session", 1, "unique execution phrase");
  await insertEvent(sql, "diagnostic-session", 1, "unique execution phrase");
  await insertEvent(sql, "source-item-session", 1, "output artifact marker");
  await insertEvent(sql, "denied-session", 1, "secretphrase restricted result");
  await sql`
    UPDATE sessions
    SET caller_session_id = 'caller-parent', predecessor_session_id = 'predecessor-only'
    WHERE session_id IN ('task-session', 'actual-work-session')
  `;
  await sql`
    UPDATE sessions SET updated_at = ${new Date(Date.now() + 86_400_000)}
    WHERE session_id = 'diagnostic-session'
  `;

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
  await sql`
    INSERT INTO task_sections (id, task_id, position_key, title, updated_session_id)
    VALUES ('search-section', 'task-primary', 'a', 'Search work', 'metadata-only-session')
  `;
  await sql`
    INSERT INTO task_items (
      id, section_id, position_key, title, status, completed_session_id
    ) VALUES (
      'execution-item', 'search-section', 'a', 'Unique execution verification',
      'completed', 'actual-work-session'
    )
  `;
  await sql`
    INSERT INTO task_items (
      id, section_id, position_key, title, updated_session_id
    ) VALUES (
      'source-item', 'search-section', 'b', 'Output artifact marker', 'metadata-only-session'
    )
  `;
  await sql`
    INSERT INTO task_items (
      id, section_id, position_key, title, updated_session_id
    ) VALUES (
      'history-item', 'search-section', 'c', 'Edit history only', 'metadata-only-session'
    )
  `;
  await sql`
    INSERT INTO task_operations (
      id, task_id, target_kind, target_id, operation_type, actor_session_id
    ) VALUES (
      'history-operation', 'task-primary', 'task', 'task-primary', 'updated', 'metadata-only-session'
    )
  `;
  await sql`
    INSERT INTO board_items (
      id, folder_id, container_kind, container_id, membership_kind, item_type, item_id
    ) VALUES (
      'actual-work-membership', 'folder-allowed', 'task', 'task-primary',
      'primary', 'session', 'actual-work-session'
    ), (
      'source-item-membership', 'folder-allowed', 'task', 'task-primary',
      'primary', 'session', 'source-item-session'
    ), (
      'referenced-folder-membership', 'folder-allowed', 'folder', 'folder-allowed',
      'primary', 'session', 'referenced-session'
    ), (
      'referenced-task-membership', 'folder-allowed', 'task', 'task-primary',
      'reference', 'session', 'referenced-session'
    )
  `;
  await sql`
    UPDATE board_items SET source_task_item_id = 'source-item'
    WHERE id = 'source-item-membership'
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

async function waitForActiveSearch(
  sql: ReturnType<typeof postgres>,
  queryMarker: string,
): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const active = await sql`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND query LIKE ${`%${queryMarker}%`}
    `;
    if (active.length > 0) return Number(active[0]?.pid);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`PostgreSQL did not report active search query ${queryMarker}`);
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

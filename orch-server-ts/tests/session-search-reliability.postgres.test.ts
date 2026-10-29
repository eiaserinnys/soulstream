import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  let schemaInstalledEventSearchDefinition: Array<{ definition: string }> = [];

  beforeAll(async () => {
    ({ sql, databaseUrl, cleanup } = await createHarness());
    await seedSearchFixtures(sql);
    schemaInstalledEventSearchDefinition = await readFunctionDefinition(sql, "event_search");
  }, 60_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("matches legacy metadata across event types and card-link paths", async () => {
    const sessionIds = [
      "metadata-own-card-session",
      "metadata-assignee-session",
      "metadata-completed-session",
      "metadata-empty-session",
    ];
    await sql`
      INSERT INTO sessions (session_id, folder_id, display_name, status, session_type)
      VALUES
        ('metadata-own-card-session', 'folder-allowed', 'Own card', 'idle', 'claude'),
        ('metadata-assignee-session', 'folder-allowed', 'Assignee card', 'idle', 'claude'),
        ('metadata-completed-session', 'folder-allowed', 'Completed card', 'idle', 'claude'),
        ('metadata-empty-session', 'folder-allowed', 'No events', 'idle', 'claude')
    `;
    await sql`
      INSERT INTO cards (id, folder_id, position_key, title, status, assignee_kind, assignee_session_id)
      VALUES
        ('metadata-own-card', 'folder-allowed', 'm1', 'Session reference', 'running', NULL, NULL),
        ('metadata-own-assignee-decoy', 'folder-allowed', 'm2', 'Assignee decoy', 'done', 'session', 'metadata-own-card-session'),
        ('metadata-assignee-card', 'folder-allowed', 'm3', 'Assigned card', 'running', 'session', 'metadata-assignee-session'),
        ('metadata-assignee-completed-decoy', 'folder-allowed', 'm4', 'Completed decoy', 'done', NULL, NULL),
        ('metadata-completed-card', 'folder-allowed', 'm5', 'Completed card', 'done', NULL, NULL)
    `;
    await sql`
      UPDATE sessions SET card_id = 'metadata-own-card'
      WHERE session_id = 'metadata-own-card-session'
    `;
    await sql`
      UPDATE cards SET completed_session_id = 'metadata-assignee-session'
      WHERE id = 'metadata-assignee-completed-decoy'
    `;
    await sql`
      UPDATE cards SET completed_session_id = 'metadata-completed-session'
      WHERE id = 'metadata-completed-card'
    `;
    const metadataEvents = [
      ["metadata-own-card-session", 1, "user_message"],
      ["metadata-own-card-session", 2, "intervention_sent"],
      ["metadata-own-card-session", 3, "session_notification"],
      ["metadata-own-card-session", 4, "turn_summary"],
      ["metadata-own-card-session", 5, "assistant_message"],
      ["metadata-assignee-session", 1, "user_message"],
      ["metadata-assignee-session", 2, "user_message"],
      ["metadata-assignee-session", 3, "assistant_message"],
      ["metadata-completed-session", 1, "assistant_message"],
      ["metadata-completed-session", 2, "session_notification"],
    ] as const;
    for (const [sessionId, id, eventType] of metadataEvents) {
      await sql`
        INSERT INTO events (session_id, id, event_type, searchable_text)
        VALUES (${sessionId}, ${id}, ${eventType}, ${`event ${id}`})
      `;
    }
    await sql`
      INSERT INTO session_digests (session_id, narrative, highlight, narrative_through_event_id)
      VALUES ('metadata-own-card-session', 'Narrative', 'Search highlight', 4)
    `;

    const legacyRows = await sql<Array<{
      session_id: string;
      turn_count: number;
      has_turn_summaries: boolean;
      has_story_digest: boolean;
      has_highlight: boolean;
      card_id: string | null;
      card_number: number | null;
      card_title: string | null;
      card_status: string | null;
    }>>`
      WITH requested AS (
        SELECT UNNEST(${sessionIds}::text[]) AS session_id
      )
      SELECT
        requested.session_id,
        COUNT(e.id) FILTER (
          WHERE e.event_type IN ('user_message', 'intervention_sent', 'session_notification')
        )::integer AS turn_count,
        COALESCE(BOOL_OR(e.event_type = 'turn_summary'), false) AS has_turn_summaries,
        (d.session_id IS NOT NULL) AS has_story_digest,
        COALESCE(NULLIF(BTRIM(d.highlight), '') IS NOT NULL, false) AS has_highlight,
        linked_card.id AS card_id,
        linked_card.number AS card_number,
        linked_card.title AS card_title,
        linked_card.status AS card_status
      FROM requested
      LEFT JOIN sessions session ON session.session_id = requested.session_id
      LEFT JOIN events e ON e.session_id = requested.session_id
      LEFT JOIN session_digests d ON d.session_id = requested.session_id
      LEFT JOIN LATERAL (
        SELECT card.id, card.number, card.title, card.status
        FROM cards card
        WHERE card.id = session.card_id
          OR (card.assignee_session_id = session.session_id AND card.archived = FALSE)
          OR (card.completed_session_id = session.session_id AND card.archived = FALSE)
        ORDER BY
          CASE
            WHEN card.id = session.card_id THEN 0
            WHEN card.assignee_session_id = session.session_id THEN 1
            ELSE 2
          END,
          card.updated_at DESC,
          card.id ASC
        LIMIT 1
      ) linked_card ON TRUE
      GROUP BY requested.session_id, d.session_id, d.highlight,
        linked_card.id, linked_card.number, linked_card.title, linked_card.status
    `;
    const metadataRows = await new SessionStoryReadRepository(sql as unknown as SqlClient)
      .getSessionSearchMetadata(sessionIds);

    const actualRows = metadataRows.map(([sessionId, metadata]) => ({
      session_id: sessionId,
      turn_count: metadata.turnCount,
      has_turn_summaries: metadata.hasTurnSummaries,
      has_story_digest: metadata.hasStoryDigest,
      has_highlight: metadata.hasHighlight,
      card_id: metadata.cardId,
      card_number: metadata.cardNumber,
      card_title: metadata.cardTitle,
      card_status: metadata.cardStatus,
    })).sort((left, right) => left.session_id.localeCompare(right.session_id));
    expect(actualRows).toEqual(
      [...legacyRows].sort((left, right) => left.session_id.localeCompare(right.session_id)),
    );
  }, 30_000);

  it("backfills exact term document frequencies and tracks index lifecycle atomically", async () => {
    const migration = readFileSync(fileURLToPath(new URL(
      "../../packages/db-schema/sql/migrations/099_event_search_term_document_frequency.sql",
      import.meta.url,
    )), "utf8");

    await sql.begin(async (tx) => {
      await tx`DROP TRIGGER IF EXISTS trg_event_search_term_df_insert ON event_search_terms`;
      await tx`DROP TRIGGER IF EXISTS trg_event_search_term_df_update ON event_search_terms`;
      await tx`DROP TRIGGER IF EXISTS trg_event_search_term_df_delete ON event_search_terms`;
      await tx`DELETE FROM event_search_term_document_frequency`;
      await tx.unsafe(migration);
    });
    await expectTermDocumentFrequenciesMatchPostings(sql);

    await sql`INSERT INTO sessions (session_id, status) VALUES ('df-lifecycle-a', 'idle')`;
    await sql`INSERT INTO sessions (session_id, status) VALUES ('df-lifecycle-b', 'idle')`;
    await sql`
      INSERT INTO events (session_id, id, event_type, searchable_text)
      VALUES ('df-lifecycle-a', 1, 'user_message', 'alpha shared shared')
    `;
    await sql`
      INSERT INTO events (session_id, id, event_type, searchable_text)
      VALUES ('df-lifecycle-b', 1, 'assistant_message', 'shared gamma')
    `;
    await expect(sql`
      SELECT document_count FROM event_search_term_document_frequency WHERE term = 'shared'
    `).resolves.toEqual([{ document_count: "2" }]);
    await expectTermDocumentFrequenciesMatchPostings(sql);

    await sql`DELETE FROM event_search_term_document_frequency WHERE term = 'alpha'`;
    await expect(sql`SELECT event_search_document_frequency('alpha') AS document_count`)
      .rejects.toMatchObject({ code: "55000" });
    await sql`
      INSERT INTO event_search_term_document_frequency (term, document_count)
      SELECT term, COUNT(*)::BIGINT FROM event_search_terms WHERE term = 'alpha' GROUP BY term
    `;
    await expectTermDocumentFrequenciesMatchPostings(sql);

    await sql`
      UPDATE events SET searchable_text = 'shared beta beta'
      WHERE session_id = 'df-lifecycle-a' AND id = 1
    `;
    await expect(sql`
      SELECT document_count FROM event_search_term_document_frequency WHERE term = 'shared'
    `).resolves.toEqual([{ document_count: "2" }]);
    await expectTermDocumentFrequenciesMatchPostings(sql);

    await sql`
      UPDATE event_search_terms SET term = 'renamed'
      WHERE session_id = 'df-lifecycle-a' AND event_id = 1 AND term = 'shared'
    `;
    await expect(sql`
      SELECT term, document_count FROM event_search_term_document_frequency
      WHERE term IN ('shared', 'renamed') ORDER BY term
    `).resolves.toEqual([
      { term: "renamed", document_count: "1" },
      { term: "shared", document_count: "1" },
    ]);
    await expectTermDocumentFrequenciesMatchPostings(sql);

    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO events (session_id, id, event_type, searchable_text)
        VALUES ('df-lifecycle-a', 2, 'user_message', 'rollback only')
      `;
      throw new Error("rollback the event and its term statistics");
    }).catch((error: unknown) => {
      expect(error).toMatchObject({ message: "rollback the event and its term statistics" });
    });
    await expectTermDocumentFrequenciesMatchPostings(sql);
    await expect(sql`
      SELECT count(*)::integer AS count FROM events
      WHERE session_id = 'df-lifecycle-a' AND id = 2
    `).resolves.toEqual([{ count: 0 }]);

    await sql`DELETE FROM events WHERE session_id = 'df-lifecycle-a' AND id = 1`;
    await expect(sql`
      SELECT document_count FROM event_search_term_document_frequency WHERE term = 'shared'
    `).resolves.toEqual([{ document_count: "1" }]);
    await expectTermDocumentFrequenciesMatchPostings(sql);

    await sql`DELETE FROM sessions WHERE session_id = 'df-lifecycle-b'`;
    await expect(sql`
      SELECT term, document_count FROM event_search_term_document_frequency
      WHERE term IN ('gamma', 'shared') ORDER BY term
    `).resolves.toEqual([
      { term: "gamma", document_count: "0" },
      { term: "shared", document_count: "0" },
    ]);
    await expectTermDocumentFrequenciesMatchPostings(sql);
  }, 30_000);

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

  it("preserves global BM25 scores when session IDs scope candidate postings", async () => {
    const query = "unique execution phrase";
    const all = await sql`
      SELECT id, session_id, score FROM event_search(
        ${query}, NULL, 100, ARRAY['assistant_message']::text[]
      ) ORDER BY session_id, id
    `;
    const scoped = await sql`
      SELECT id, session_id, score FROM event_search(
        ${query}, ARRAY['actual-work-session']::text[], 100,
        ARRAY['assistant_message']::text[]
      ) ORDER BY session_id, id
    `;

    expect(scoped).toEqual(all.filter((row) => row.session_id === "actual-work-session"));

    const excludedType = await sql`
      SELECT id, session_id FROM event_search(
        ${query}, ARRAY['actual-work-session']::text[], 100,
        ARRAY['user_message']::text[]
      )
    `;
    expect(excludedType).toHaveLength(0);
  });

  it("reads integer postings with the same search contract and supports migration replay", async () => {
    const canonicalDefinition = schemaInstalledEventSearchDefinition;
    const canonicalIndex = await readPrefixIndexDefinition(sql);
    const previousSearchMigration = readFileSync(fileURLToPath(new URL(
      "../../packages/db-schema/sql/migrations/103_event_search_aggregate_postings.sql",
      import.meta.url,
    )), "utf8");
    const readV2Migration = readFileSync(fileURLToPath(new URL(
      "../../packages/db-schema/sql/migrations/134_event_search_read_v2.sql",
      import.meta.url,
    )), "utf8");

    await sql.unsafe(previousSearchMigration);
    await sql.unsafe(`
      ALTER FUNCTION event_search(
        text, text[], integer, text[], text[], integer, integer, text,
        text[], timestamptz, text[], jsonb
      ) RENAME TO event_search_before_read_v2
    `);

    await sql`INSERT INTO sessions (
      session_id, folder_id, display_name, status, session_type,
      node_id, agent_id, model_preset, updated_at
    ) VALUES
      ('prefix-read-v2-exact', 'folder-allowed', 'prefix-read-v2-exact', 'idle', 'claude', NULL, NULL, NULL, NOW()),
      ('prefix-read-v2-wide', 'folder-allowed', 'prefix-read-v2-wide', 'idle', 'claude', NULL, NULL, NULL, NOW()),
      ('prefix-read-v2-astral', 'folder-allowed', 'prefix-read-v2-astral', 'idle', 'claude', NULL, NULL, NULL, NOW()),
      ('prefix-read-v2-false-n', 'folder-allowed', 'prefix-read-v2-false-n', 'idle', 'claude', NULL, NULL, NULL, NOW()),
      ('prefix-read-v2-false-a', 'folder-allowed', 'prefix-read-v2-false-a', 'idle', 'claude', NULL, NULL, NULL, NOW()),
      ('search-filter-preset', 'folder-allowed', 'search-filter-preset', 'idle', 'claude', 'filter-node', 'agent-shared', 'preset-new', NOW()),
      ('search-filter-fallback', 'folder-allowed', 'search-filter-fallback', 'idle', 'claude', 'filter-node', 'agent-shared', 'preset-old', NOW())
    `;
    await sql`
      INSERT INTO events (session_id, id, event_type, searchable_text, created_at)
      VALUES
        ('prefix-read-v2-exact', 1, 'assistant_message', '디스크', NOW()),
        ('prefix-read-v2-wide', 1, 'assistant_message', '디스크위생', NOW()),
        ('prefix-read-v2-astral', 1, 'assistant_message', '디스크𐐀', NOW()),
        ('prefix-read-v2-false-n', 1, 'assistant_message', '디스큰', NOW()),
        ('prefix-read-v2-false-a', 1, 'assistant_message', '디스카', NOW()),
        ('search-filter-preset', 1, 'assistant_message', 'filtermarker raretoken', NOW()),
        ('search-filter-preset', 2, 'assistant_message', 'filtermarker raretoken', NOW()),
        ('search-filter-fallback', 1, 'tool_result', 'filtermarker raretoken', NOW()),
        ('actual-work-session', 51, 'assistant_message', '디스크위생 기록', NOW())
    `;

    // Recreate the 133 index to exercise the upgrade as well as fresh schema.
    await sql`DROP INDEX IF EXISTS event_search_dictionary_korean_prefix`;
    await sql`CREATE INDEX IF NOT EXISTS event_search_dictionary_prefix_cover
      ON event_search_dictionary ((term COLLATE "C")) INCLUDE (term_id, term)`;
    await sql.begin((tx) => tx.unsafe(readV2Migration));
    const afterFirstMigration = await readFunctionDefinition(sql, "event_search");
    expect(await readPrefixIndexDefinition(sql)).toEqual(canonicalIndex);
    await sql.begin((tx) => tx.unsafe(readV2Migration));
    const afterReplay = await readFunctionDefinition(sql, "event_search");
    expect(afterFirstMigration[0]?.definition).toBe(canonicalDefinition[0]?.definition);
    expect(afterReplay[0]?.definition).toBe(canonicalDefinition[0]?.definition);
    expect(await readPrefixIndexDefinition(sql)).toEqual(canonicalIndex);
    expect(canonicalIndex.map((row) => row.name)).toEqual(["event_search_dictionary_korean_prefix"]);
    const prefixPlan = await sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      return await tx`EXPLAIN SELECT term_id FROM event_search_dictionary
        WHERE left(term, 3) = '디스크' AND term ~ '[가-힣]'`;
    });
    expect(prefixPlan.map((row) => row["QUERY PLAN"]).join("\n"))
      .toContain("event_search_dictionary_korean_prefix");
    const documentFrequencyDefinition = await readFunctionDefinition(
      sql,
      "event_search_document_frequency",
    );
    expect(documentFrequencyDefinition[0]?.definition).toContain("event_search_postings");
    expect(documentFrequencyDefinition[0]?.definition).not.toContain("FROM event_search_terms");

    const tokens = await sql`SELECT event_search_tokenize('디스크𐐀') AS tokens`;
    expect(tokens[0]?.tokens).toContain("디스크𐐨");
    const mirrored = await sql`
      SELECT COUNT(*)::integer AS count
      FROM event_search_postings posting
      JOIN event_search_dictionary dictionary USING (term_id)
      WHERE dictionary.term IN ('디스크', '디스크위생', '디스크𐐨', '디스큰', '디스카')
    `;
    expect(mirrored[0]?.count).toBeGreaterThanOrEqual(5);

    const commonArgs: EventSearchArguments = {
      query: "commonphrase",
      sessionIds: null,
      limit: 20,
      eventTypes: ["assistant_message"],
      folderIds: null,
      perSessionLimit: null,
      prefixLimit: 0,
      nodeId: null,
      statuses: null,
      updatedAfter: null,
      backends: null,
      backendCatalog: [],
    };
    await expectSearchesEquivalent(sql, commonArgs);
    expect((await runSearchFunction(sql, "event_search", commonArgs)).length).toBeGreaterThan(0);

    await expectSearchesEquivalent(sql, {
      ...commonArgs,
      query: "unique execution phrase",
      sessionIds: ["actual-work-session"],
      limit: null,
    });
    expect((await runSearchFunction(sql, "event_search", {
      ...commonArgs, query: "unique execution phrase", sessionIds: ["actual-work-session"], limit: null,
    })).length).toBeGreaterThan(0);

    const folderPrefixArgs: EventSearchArguments = {
      ...commonArgs,
      query: "업무 검색어",
      limit: 1,
      folderIds: ["folder-allowed"],
      perSessionLimit: 1,
      prefixLimit: 2,
    };
    await expectSearchesEquivalent(sql, folderPrefixArgs);
    const independentlySlotted = await runSearchFunction(sql, "event_search", folderPrefixArgs);
    expect(independentlySlotted.length).toBeGreaterThan(folderPrefixArgs.limit ?? 0);
    expect(independentlySlotted.map((row) => row.session_id)).toContain("prefix-target");
    const scopedPrefixArgs = { ...folderPrefixArgs, sessionIds: ["prefix-target"] };
    await expectSearchesEquivalent(sql, scopedPrefixArgs);
    expect((await runSearchFunction(sql, "event_search", scopedPrefixArgs)).length).toBeGreaterThan(0);

    const prefixArgs = {
      ...commonArgs,
      query: "디스크작업",
      limit: 20,
      prefixLimit: 0,
    };
    const globalPrefix = await runSearchFunction(sql, "event_search", prefixArgs);
    expect(new Set(globalPrefix.map((row) => row.session_id))).toEqual(new Set([
      "prefix-read-v2-exact",
      "prefix-read-v2-wide",
      "prefix-read-v2-astral",
      "actual-work-session",
    ]));
    expect(globalPrefix.map((row) => row.session_id)).not.toContain("prefix-read-v2-false-n");
    expect(globalPrefix.map((row) => row.session_id)).not.toContain("prefix-read-v2-false-a");

    const scopedPrefix = await runSearchFunction(sql, "event_search", {
      ...prefixArgs,
      sessionIds: ["actual-work-session"],
      limit: 5,
    });
    expect(scopedPrefix.map((row) => row.id)).toContain(51);

    await sql`INSERT INTO events (session_id, id, event_type, searchable_text)
      VALUES ('actual-work-session', 52, 'assistant_message', '가_나머지'),
             ('actual-work-session', 53, 'assistant_message', '가X나머지')`;
    const underscore = await runSearchFunction(sql, "event_search", {
      ...prefixArgs, query: "가_나검색", sessionIds: ["actual-work-session"],
    });
    expect(underscore.map((row) => row.id)).toEqual([52]);

    const refillArgs = {
      ...commonArgs,
      query: "검색어아주없는요청",
      limit: 2,
    };
    await expectSearchesEquivalent(sql, refillArgs);
    const emptyExactRefill = await runSearchFunction(sql, "event_search", refillArgs);
    expect(emptyExactRefill.map((row) => row.session_id)).toContain("prefix-target");

    const after = new Date(Date.now() - 60_000);
    const backendCatalog: EventSearchBackendMapping[] = [
      { kind: "preset", node_id: "filter-node", model_preset: "preset-new", backend: "codex" },
      { kind: "agent", node_id: "filter-node", agent_id: "agent-shared", backend: "claude" },
    ];
    const filteredArgs: EventSearchArguments = {
      ...commonArgs,
      query: "filtermarker raretoken",
      eventTypes: ["assistant_message"],
      folderIds: ["folder-allowed"],
      perSessionLimit: 1,
      nodeId: "filter-node",
      statuses: ["idle"],
      updatedAfter: after,
      backends: ["codex"],
      backendCatalog,
    };
    await expectSearchesEquivalent(sql, filteredArgs);
    const filteredPreset = await runSearchFunction(sql, "event_search", filteredArgs);
    expect(filteredPreset).toHaveLength(1);
    expect(filteredPreset[0]?.session_id).toBe("search-filter-preset");

    const fallbackArgs: EventSearchArguments = {
      ...filteredArgs,
      sessionIds: ["search-filter-fallback"],
      eventTypes: ["tool_result"],
      backends: ["claude"],
    };
    await expectSearchesEquivalent(sql, fallbackArgs);
    const filteredFallback = await runSearchFunction(sql, "event_search", fallbackArgs);
    expect(filteredFallback.map((row) => row.session_id)).toContain("search-filter-fallback");

    const unlimited = await runSearchFunction(sql, "event_search", {
      ...commonArgs,
      limit: null,
    });
    await expectSearchesEquivalent(sql, { ...commonArgs, limit: null });
    expect(unlimited.length).toBeGreaterThan(5);
    const zero = await runSearchFunction(sql, "event_search", {
      ...commonArgs,
      limit: 0,
    });
    await expectSearchesEquivalent(sql, { ...commonArgs, limit: 0 });
    expect(zero).toHaveLength(0);
    const perSession = await runSearchFunction(sql, "event_search", {
      ...filteredArgs,
      sessionIds: ["search-filter-preset"],
      limit: null,
    });
    expect(perSession).toHaveLength(1);
  }, 60_000);

  it("drops overlong tokens and preserves the 1024-byte search boundary", async () => {
    const repeatedLatin = "a".repeat(3_000);
    const randomLatin = Array.from({ length: 50 }, (_, i) =>
      createHash("sha256").update(`event-search-random-latin-${i}`).digest("hex")).join("");
    const repeatedKorean = "가나다라마바사아자차카타파하".repeat(100);
    const randomKorean = Array.from({ length: 1_100 }, (_, i) => {
      const digest = createHash("sha256").update(`event-search-random-korean-${i}`).digest();
      return String.fromCharCode(0xac00 + (digest.readUInt32BE(0) % 11_172));
    }).join("");
    const boundaryToken = "b".repeat(1_000);
    const ordinaryTerm = "ordinarysearchterm";
    const longTokens = [repeatedLatin, randomLatin, repeatedKorean, randomKorean];

    expect(Buffer.byteLength(repeatedLatin)).toBeGreaterThan(1_024);
    expect(Buffer.byteLength(randomLatin)).toBeGreaterThan(2_704);
    expect(Buffer.byteLength(repeatedKorean)).toBeGreaterThan(1_024);
    expect(Buffer.byteLength(randomKorean)).toBeGreaterThan(2_704);
    expect(Buffer.byteLength(boundaryToken)).toBe(1_000);

    try {
      await sql`INSERT INTO sessions (session_id, status) VALUES ('long-event-search', 'idle')`;
      await sql`INSERT INTO events (session_id, id, event_type, searchable_text)
        VALUES (
          'long-event-search', 1, 'assistant_message',
          ${[...longTokens, boundaryToken, ordinaryTerm].join(" ")}
        )`;

      const legacyTerms = await sql<Array<{
        term: string;
        term_freq: number;
        doc_len: number;
      }>>`
        SELECT term, term_freq, doc_len
        FROM event_search_terms
        WHERE session_id = 'long-event-search' AND event_id = 1
        ORDER BY term
      `;
      const mirroredTerms = await sql<Array<{
        term: string;
        term_freq: number;
        doc_len: number;
      }>>`
        SELECT dictionary.term, posting.term_freq, document.doc_len
        FROM event_search_postings posting
        JOIN event_search_dictionary dictionary USING (term_id)
        JOIN event_search_session_keys session_key USING (session_key)
        JOIN event_search_documents document USING (session_key, event_id)
        WHERE session_key.session_id = 'long-event-search' AND posting.event_id = 1
        ORDER BY dictionary.term
      `;
      expect(new Set(legacyTerms.map((row) => row.term))).toEqual(
        new Set([boundaryToken, ordinaryTerm]),
      );
      expect(legacyTerms.every((row) => row.term_freq === 1 && row.doc_len === 2)).toBe(true);
      expect(mirroredTerms).toEqual(legacyTerms);

      for (const term of [ordinaryTerm, boundaryToken]) {
        const result = await sql`
          SELECT id FROM event_search(${term}, ARRAY['long-event-search']::text[])
        `;
        expect(result.map((row) => row.id)).toEqual([1]);
      }
      for (const term of longTokens) {
        const result = await sql`
          SELECT id FROM event_search(${term}, ARRAY['long-event-search']::text[])
        `;
        expect(result).toEqual([]);
      }
    } finally {
      await sql`DELETE FROM sessions WHERE session_id = 'long-event-search'`;
    }
  }, 60_000);

  it("serves the observed MCP scoped query through history_search with filters intact", async () => {
    const query = "cn-characters cn-followups cn-support cn-synopsis glossary-zh-fill glossary-mirror-from-shay retire-glossary-gsheet-sync cn-term-alignment";
    await sql`
      INSERT INTO events (session_id, id, event_type, searchable_text, created_at)
      VALUES (
        'actual-work-session', 50, 'tool_result', ${query}, NOW()
      )
    `;
    await sql`
      INSERT INTO events (session_id, id, event_type, searchable_text, created_at)
      VALUES (
        'diagnostic-session', 50, 'text_delta', ${query}, NOW()
      )
    `;
    const repository = new SessionHistorySearchRepository(
      createLiveSearchDbConnectionFactory({ databaseUrl }),
      new EventReadRepository(sql as unknown as SqlClient),
      new SessionStoryReadRepository(sql as unknown as SqlClient),
    );

    const result = await repository.search({
      query,
      sessionIds: ["actual-work-session", "diagnostic-session"],
      limit: 10,
      eventTypes: ["tool_start", "tool_result", "assistant_message", "user_message"],
      searchSessionId: false,
      includeHighlight: false,
      includeStory: false,
    }, new AbortController().signal);

    expect(result.events.map((row) => [row.session_id, row.event_type])).toEqual([
      ["actual-work-session", "tool_result"],
    ]);
    expect(result.sessionIdEvents).toEqual([]);
    expect(result.digests).toEqual([]);
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
      // 097 also replaces unrelated session filters; retain the current folder
      // schema contract while this case exercises only its compact indexes.
      const currentSchema = readFileSync(fileURLToPath(new URL(
        "../../packages/db-schema/sql/schema.sql", import.meta.url,
      )), "utf8");
      for (const name of ["session_get_all", "session_count"]) {
        const start = currentSchema.indexOf("CREATE OR REPLACE FUNCTION " + name + "(");
        const end = currentSchema.indexOf("$$;", start) + 3;
        await tx.unsafe(currentSchema.slice(start, end));
      }
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
      session_search_mode: "lexical",
      allowedFolderIds: ["folder-allowed", "task-primary"],
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
      // 097 also replaces unrelated session filters; retain the current folder
      // schema contract while this case exercises only its compact indexes.
      const currentSchema = readFileSync(fileURLToPath(new URL(
        "../../packages/db-schema/sql/schema.sql", import.meta.url,
      )), "utf8");
      for (const name of ["session_get_all", "session_count"]) {
        const start = currentSchema.indexOf("CREATE OR REPLACE FUNCTION " + name + "(");
        const end = currentSchema.indexOf("$$;", start) + 3;
        await tx.unsafe(currentSchema.slice(start, end));
      }
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

  it("uses the database key normalizer for Unicode symbol-prefixed session titles", async () => {
    const title = "🔍 세션 검색 정규화 표적";
    await sql`
      INSERT INTO sessions (session_id, folder_id, display_name, status)
      VALUES ('unicode-symbol-title', 'folder-allowed', ${title}, 'completed')
    `;
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: createLiveSearchDbConnectionFactory({ databaseUrl }),
    });

    const response = await provider.search({
      q: title,
      top_k: 10,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      session_search_mode: "lexical",
      allowedFolderIds: ["folder-allowed", "task-primary"],
    });

    expect(response.session_results?.map((row) => row.session_id))
      .toContain("unicode-symbol-title");
    expect(response.search_status?.session_sources?.metadata).toEqual({ status: "complete" });
  });

  it("finds metadata through indexed tokens when words are omitted or reordered", async () => {
    const migration = readFileSync(fileURLToPath(new URL(
      "../../packages/db-schema/sql/migrations/100_session_search_metadata_terms.sql",
      import.meta.url,
    )), "utf8");
    await sql.begin(async (tx) => {
      await tx`DROP INDEX IF EXISTS idx_sessions_display_name_search_terms`;
      await tx`DROP INDEX IF EXISTS idx_sessions_prompt_search_terms`;
      await tx`DROP FUNCTION IF EXISTS session_search_tokens(TEXT)`;
      await tx.unsafe(migration);
    });
    await sql`
      INSERT INTO sessions (session_id, folder_id, display_name, prompt, node_id, status)
      VALUES
        ('fuzzy-title-postposition', 'folder-allowed', '🔗 피드·검색 세션의 업무 자동 선택 수정', '', 'fixture-node', 'completed'),
        ('fuzzy-title-order', 'folder-allowed', '⚙️ 260924 새벽 워크트리와 원격 브랜치 정리', '', 'fixture-node', 'completed'),
        ('fuzzy-title-session-search', 'folder-allowed', '🔍 세션 검색 개선 여지 점검', '', 'fixture-node', 'completed'),
        ('fuzzy-prompt-omission', 'folder-allowed', '연결된 작업 메모', '실제 작업 세션 검색·재개 진단', 'fixture-node', 'completed'),
        ('fuzzy-prompt-below-threshold', 'folder-allowed', '일부 단어만 겹치는 기록', '이전 세션 검색 기록', 'fixture-node', 'completed'),
        ('fuzzy-prompt-many-terms', 'folder-allowed', '긴 검색어 fallback 확인', '하나 둘 셋 넷 다섯 여섯 일곱 기록', 'fixture-node', 'completed')
    `;
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: createLiveSearchDbConnectionFactory({ databaseUrl }),
    });
    const search = async (query: string) => provider.search({
      q: query,
      top_k: 10,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      session_search_mode: "lexical",
      allowedFolderIds: ["folder-allowed", "task-primary"],
    });

    const postposition = await search("피드 검색 세션 업무 자동 선택 수정");
    expect(postposition.session_results?.map((row) => row.session_id))
      .toContain("fuzzy-title-postposition");
    expect(postposition.session_results?.[0]?.session_id).toBe("fuzzy-title-postposition");
    const punctuation = await search("피드·검색 세션의 업무 자동 선택 수정");
    expect(punctuation.session_results?.[0]?.session_id).toBe("fuzzy-title-postposition");
    const reorderedPostposition = await search("수정 자동 업무 선택 검색 세션");
    expect(reorderedPostposition.session_results?.[0]?.session_id)
      .toBe("fuzzy-title-postposition");
    const reordered = await search("정리 원격 워크트리 새벽");
    expect(reordered.session_results?.map((row) => row.session_id))
      .toContain("fuzzy-title-order");
    expect(reordered.session_results?.[0]?.session_id).toBe("fuzzy-title-order");
    const thirdTitle = await search("검색 세션의 점검 여지 개선");
    expect(thirdTitle.session_results?.[0]?.session_id).toBe("fuzzy-title-session-search");
    const omitted = await search("재개 세션 검색 진단");
    expect(omitted.session_results?.map((row) => row.session_id))
      .not.toContain("fuzzy-prompt-omission");
    expect(omitted.search_status?.session_sources?.metadata_prompt_tokens)
      .toEqual({ status: "deferred" });

    const expandedPromptProvider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: createLiveSearchDbConnectionFactory({ databaseUrl }),
    });
    const expandedPrompt = await expandedPromptProvider.search({
      q: "재개 세션 검색 진단",
      top_k: 10,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      session_search_mode: "expanded",
      allowedFolderIds: ["folder-allowed", "task-primary"],
    });
    expect(expandedPrompt.session_results?.[0]?.session_id).toBe("fuzzy-prompt-omission");
    expect(expandedPrompt.search_status?.session_sources?.metadata_prompt_tokens)
      .toEqual({ status: "deferred" });

    const manyTermPrompt = await expandedPromptProvider.search({
      q: "하나 둘 셋 넷 다섯 여섯 일곱 여덟 아홉",
      top_k: 10,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      session_search_mode: "expanded",
      allowedFolderIds: ["folder-allowed", "task-primary"],
    });
    expect(manyTermPrompt.session_results?.[0]?.session_id)
      .toBe("fuzzy-prompt-many-terms");

    await sql`SET enable_seqscan = off`;
    const plan = await sql`
      EXPLAIN SELECT session_id FROM sessions
      WHERE session_search_tokens(display_name)
        && session_search_tokens(${"피드 검색 세션 업무 자동 선택 수정"})
    `;
    await sql`RESET enable_seqscan`;
    expect(plan.map((row) => JSON.stringify(row)).join("\n"))
      .toContain("idx_sessions_display_name_search_terms");
    await sql`SET enable_seqscan = off`;
    const promptPlan = await sql`
      EXPLAIN SELECT session_id FROM sessions
      WHERE session_search_tokens(prompt)
        @> ARRAY['세션', '검색', '진단']::text[]
    `;
    expect(promptPlan.map((row) => JSON.stringify(row)).join("\n"))
      .toContain("idx_sessions_prompt_search_terms");
    await sql`RESET enable_seqscan`;
    expect(postposition.search_status?.session_sources?.original_body)
      .toEqual({ status: "deferred" });
  }, 30_000);

  it("keeps event-only content deferred in expanded product search", async () => {
    const lexicalProvider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: createLiveSearchDbConnectionFactory({ databaseUrl }),
    });
    const lexical = await lexicalProvider.search({
      q: "unique execution phrase",
      top_k: 10,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      session_search_mode: "lexical",
      allowedFolderIds: ["folder-allowed", "task-primary"],
    });

    expect(lexical.session_results).toEqual([]);
    expect(lexical.search_status?.session_sources).toEqual({
      metadata: { status: "complete" },
      metadata_prompt_tokens: { status: "deferred" },
      original_body: { status: "deferred" },
      semantic_body: { status: "deferred" },
    });

    const expandedProvider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: createLiveSearchDbConnectionFactory({ databaseUrl }),
    });
    const expanded = await expandedProvider.search({
      q: "unique execution phrase",
      top_k: 10,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      session_search_mode: "expanded",
      allowedFolderIds: ["folder-allowed", "task-primary"],
    });

    expect(expanded.results).toEqual([]);
    expect(expanded.search_status?.session_sources?.original_body).toEqual({ status: "deferred" });
    expect(expanded.search_status?.session_sources?.semantic_body).toEqual({ status: "deferred" });
    expect(expanded.search_status?.session_sources?.session_document).toEqual({ status: "complete" });
    expect(expanded.search_status?.session_sources?.rerank).toMatchObject({
      status: "partial",
      reason: "error",
    });
  });

  it("projects the authorized primary task membership for a real session search", async () => {
    await sql`UPDATE sessions SET display_name = 'Search task result' WHERE session_id = 'task-session'`;
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
      session_search_mode: "lexical",
      allowedFolderIds: ["folder-allowed", "task-primary"],
    });

    expect(response.session_results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        session_id: "task-session",
        folder_id: "task-primary",
        folder_name: "Search task result",
      }),
    ]));
    expect(response.session_results?.map((row) => row.session_id)).not.toContain("denied-session");
    expect(response.session_results?.find((row) => row.session_id === "task-session"))
      .toMatchObject({ parent_session_id: "caller-parent" });
  });

  it("projects caller and primary task evidence onto title candidates", async () => {
    await sql`UPDATE sessions SET display_name = 'unique execution phrase' WHERE session_id = 'actual-work-session'`;
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
      session_search_mode: "lexical",
      allowedFolderIds: ["folder-allowed", "task-primary"],
    });

    expect(execution.session_results?.map((row) => row.session_id)).toContain("actual-work-session");
    expect(execution.session_results?.find((row) => row.session_id === "actual-work-session")).toMatchObject({
      folder_id: "task-primary",
      parent_session_id: "caller-parent",
    });
    expect(execution.session_results?.find((row) => row.session_id === "actual-work-session")?.evidence)
      .toContainEqual(expect.objectContaining({
      source: "card_completed",
      excerpt: "Unique execution verification",
    }));
    expect(execution.session_results?.find((row) => row.session_id === "actual-work-session"))
      .toMatchObject({ card_id: "execution-item", card_title: "Unique execution verification", card_status: "done" });
    await sql`UPDATE sessions SET display_name = 'actual-work-session' WHERE session_id = 'actual-work-session'`;

    await sql`
      UPDATE sessions SET display_name = 'task result metadata'
      WHERE session_id IN ('referenced-session', 'metadata-only-session')
    `;
    await sql`INSERT INTO cards (
      id, folder_id, position_key, title, status, assignee_kind, assignee_session_id
    ) VALUES (
      'assigned-card', 'folder-allowed', 'a', 'Assigned card', 'running', 'session', 'metadata-only-session'
    )`;
    await sql`INSERT INTO cards (
      id, folder_id, position_key, title, status, completed_session_id
    ) VALUES (
      'completed-decoy', 'folder-allowed', 'b', 'Completed decoy', 'done', 'metadata-only-session'
    )`;
    const taskTitleSearch = await provider.search({
      q: "task result",
      top_k: 20,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      session_search_mode: "lexical",
      allowedFolderIds: ["folder-allowed", "task-primary"],
    });
    for (const sessionId of ["referenced-session", "metadata-only-session"]) {
      expect(taskTitleSearch.session_results?.find((row) => row.session_id === sessionId)?.folder_id)
        .toBe("folder-allowed");
    }
    expect(taskTitleSearch.session_results?.find((row) => row.session_id === "metadata-only-session"))
      .toMatchObject({ card_id: "assigned-card", card_title: "Assigned card", card_status: "running" });
    await sql`
      UPDATE sessions SET display_name = session_id
      WHERE session_id IN ('referenced-session', 'metadata-only-session')
    `;

    await sql`UPDATE sessions SET display_name = 'output artifact marker' WHERE session_id = 'source-item-session'`;
    await sql`UPDATE cards SET assignee_kind='session', assignee_session_id='source-item-session' WHERE id='history-item'`;
    const outputSearch = await provider.search({
      q: "output artifact marker",
      top_k: 10,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      session_search_mode: "lexical",
      allowedFolderIds: ["folder-allowed", "task-primary"],
    });
    expect(outputSearch.session_results?.find((row) => row.session_id === "source-item-session")?.evidence)
      .toContainEqual(expect.objectContaining({ source: "source_card" }));
    expect(outputSearch.session_results?.find((row) => row.session_id === "source-item-session"))
      .toMatchObject({
        card_id: "source-item",
        card_number: expect.any(Number),
        card_title: "Output artifact marker",
        card_status: "todo",
      });
    await sql`UPDATE sessions SET folder_id = NULL WHERE session_id = 'source-item-session'`;
    const unfiledSearch = await provider.search({
      q: "output artifact marker",
      top_k: 10,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      session_search_mode: "lexical",
    });
    expect(unfiledSearch.session_results?.find((row) => row.session_id === "source-item-session"))
      .toMatchObject({ card_id: "source-item", card_title: "Output artifact marker", card_status: "todo" });
    await sql`UPDATE sessions SET folder_id = 'task-primary' WHERE session_id = 'source-item-session'`;
    await sql`UPDATE sessions SET display_name = 'source-item-session' WHERE session_id = 'source-item-session'`;
  });

  it("returns separate session-document candidates despite repeated matching events", async () => {
    await sql`INSERT INTO sessions (session_id, folder_id, display_name, status, session_type)
      VALUES ('crowded-session', 'folder-allowed', 'Crowded session', 'idle', 'claude'),
             ('distinct-session', 'folder-allowed', 'Distinct session', 'idle', 'claude')`;
    await sql`
      UPDATE sessions SET prompt = 'search crowd distinct work'
      WHERE session_id IN ('crowded-session', 'distinct-session')
    `;
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
      top_k: 10,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      allowedFolderIds: ["folder-allowed", "task-primary"],
    });

    expect(response.results).toEqual([]);
    expect(response.session_results?.map((result) => result.session_id))
      .toEqual(expect.arrayContaining(["crowded-session", "distinct-session"]));
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
      allowedFolderIds: ["folder-allowed", "task-primary"],
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
      await waitForNoBackend(admin, pid);
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
    // Runtime queries use the final canonical schema. Historical migration tests
    // below apply their own migrations explicitly.
    await bootstrap.unsafe(schema);
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

type EventSearchArguments = {
  query: string;
  sessionIds: string[] | null;
  limit: number | null;
  eventTypes: string[] | null;
  folderIds: string[] | null;
  perSessionLimit: number | null;
  prefixLimit: number;
  nodeId: string | null;
  statuses: string[] | null;
  updatedAfter: Date | null;
  backends: string[] | null;
  backendCatalog: EventSearchBackendMapping[];
};

type EventSearchRow = {
  id: number;
  session_id: string;
  event_type: string;
  payload: unknown;
  searchable_text: string;
  created_at: string | null;
  score: number | string;
};

type EventSearchBackendMapping =
  | { kind: "preset"; node_id: string; model_preset: string; backend: string }
  | { kind: "agent"; node_id: string; agent_id: string; backend: string };

type EventSearchFunctionName = "event_search" | "event_search_before_read_v2";

async function readPrefixIndexDefinition(sql: ReturnType<typeof postgres>) {
  return await sql<Array<{ name: string; definition: string }>>`
    SELECT c.relname AS name, pg_get_indexdef(c.oid) AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname IN ('event_search_dictionary_prefix_cover', 'event_search_dictionary_korean_prefix')
    ORDER BY c.relname
  `;
}

async function readFunctionDefinition(
  sql: ReturnType<typeof postgres>,
  functionName: "event_search" | "event_search_document_frequency",
): Promise<Array<{ definition: string }>> {
  return await sql`
    SELECT replace(
      pg_get_functiondef(p.oid),
      format('FUNCTION %I.', n.nspname),
      'FUNCTION '
    ) AS definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema()
      AND p.proname = ${functionName}
  `;
}

async function runSearchFunction(
  sql: ReturnType<typeof postgres>,
  functionName: EventSearchFunctionName,
  args: EventSearchArguments,
): Promise<EventSearchRow[]> {
  return await sql.unsafe(
    `SELECT id, session_id, event_type, payload, searchable_text, created_at::text AS created_at, score
     FROM ${functionName}(
       $1::text, $2::text[], $3::integer, $4::text[], $5::text[],
       $6::integer, $7::integer, $8::text, $9::text[], $10::timestamptz,
       $11::text[], $12::text::jsonb
     )`,
    [
      args.query,
      args.sessionIds,
      args.limit,
      args.eventTypes,
      args.folderIds,
      args.perSessionLimit,
      args.prefixLimit,
      args.nodeId,
      args.statuses,
      args.updatedAfter,
      args.backends,
      JSON.stringify(args.backendCatalog),
    ],
  );
}

async function expectSearchesEquivalent(
  sql: ReturnType<typeof postgres>,
  args: EventSearchArguments,
): Promise<void> {
  const legacyRows = await runSearchFunction(sql, "event_search_before_read_v2", args);
  const currentRows = await runSearchFunction(sql, "event_search", args);
  expectEquivalentRows(legacyRows, currentRows);
}

function expectEquivalentRows(legacyRows: EventSearchRow[], currentRows: EventSearchRow[]): void {
  const key = (row: EventSearchRow) => `${row.session_id}/${row.id}`;
  const timestamp = (row: EventSearchRow) => row.created_at;
  expect(currentRows).toHaveLength(legacyRows.length);
  for (let start = 0; start < legacyRows.length;) {
    const first = legacyRows[start]!;
    let end = start + 1;
    while (end < legacyRows.length && Number(legacyRows[end]!.score) === Number(first.score)
      && timestamp(legacyRows[end]!) === timestamp(first)) end++;
    const legacyGroup = legacyRows.slice(start, end);
    const currentGroup = currentRows.slice(start, end);
    expect(new Set(currentGroup.map(key))).toEqual(new Set(legacyGroup.map(key)));
    for (const current of currentGroup) {
      const legacy = legacyGroup.find((row) => key(row) === key(current))!;
      expect(current.event_type).toBe(legacy.event_type);
      expect(current.payload).toEqual(legacy.payload);
      expect(current.searchable_text).toBe(legacy.searchable_text);
      expect(timestamp(current)).toBe(timestamp(legacy));
      expect(Math.abs(Number(current.score) - Number(legacy.score))).toBeLessThanOrEqual(1e-12);
    }
    start = end;
  }
}

it("compares returned order while allowing only true ties to swap", () => {
  const row = (id: number, score: number, created_at: string): EventSearchRow => ({
    id, session_id: "ordering", event_type: "assistant_message", payload: null,
    searchable_text: "test", created_at, score,
  });
  const newer = "2026-10-29 00:00:00.000002+00";
  const older = "2026-10-29 00:00:00.000001+00";
  const expected = [row(1, 3, newer), row(2, 3, newer), row(3, 3, older), row(4, 2, newer)];
  expectEquivalentRows(expected, [expected[1]!, expected[0]!, expected[2]!, expected[3]!]);
  expect(() => expectEquivalentRows(expected, [expected[2]!, expected[1]!, expected[0]!, expected[3]!])).toThrow();
  expect(() => expectEquivalentRows(expected, [expected[3]!, expected[1]!, expected[2]!, expected[0]!])).toThrow();
});

async function expectTermDocumentFrequenciesMatchPostings(sql: ReturnType<typeof postgres>) {
  const mismatches = await sql`
    WITH expected AS (
      SELECT term, COUNT(*)::BIGINT AS document_count
      FROM event_search_terms GROUP BY term
    ), actual AS (
      SELECT term, document_count
      FROM event_search_term_document_frequency
      WHERE document_count > 0
    )
    (SELECT term, document_count FROM expected
     EXCEPT SELECT term, document_count FROM actual)
    UNION ALL
    (SELECT term, document_count FROM actual
     EXCEPT SELECT term, document_count FROM expected)
  `;
  expect(mismatches).toEqual([]);
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
      id, folder_id, membership_kind, item_type, item_id
    ) VALUES (
      'task-board-item', 'folder-allowed',
      'primary', 'subfolder', 'task-primary'
    )
  `;
  await sql`
    INSERT INTO folders (id, parent_folder_id, name)
    VALUES ('task-primary', 'folder-allowed', 'Search task result')
  `;
  await sql`
    INSERT INTO board_items (
      id, folder_id, membership_kind, item_type, item_id
    ) VALUES (
      'task-session-membership', 'task-primary',
      'primary', 'session', 'task-session'
    )
  `;
  await sql`
    INSERT INTO cards (
      id, folder_id, position_key, title, status, completed_session_id
    ) VALUES (
      'execution-item', 'task-primary', 'a', 'Unique execution verification',
      'done', 'actual-work-session'
    )
  `;
  await sql`
    INSERT INTO cards (
      id, folder_id, position_key, title, updated_session_id
    ) VALUES (
      'source-item', 'task-primary', 'b', 'Output artifact marker', 'metadata-only-session'
    )
  `;
  await sql`
    INSERT INTO cards (
      id, folder_id, position_key, title, updated_session_id
    ) VALUES (
      'history-item', 'task-primary', 'c', 'Edit history only', 'metadata-only-session'
    )
  `;
  await sql`
    INSERT INTO folder_operations (
      id, folder_id, target_kind, target_id, operation_type, actor_session_id
    ) VALUES (
      'history-operation', 'task-primary', 'folder', 'task-primary', 'updated', 'metadata-only-session'
    )
  `;
  await sql`
    INSERT INTO board_items (
      id, folder_id, membership_kind, item_type, item_id
    ) VALUES (
      'actual-work-membership', 'task-primary',
      'primary', 'session', 'actual-work-session'
    ), (
      'source-item-membership', 'task-primary',
      'primary', 'session', 'source-item-session'
    ), (
      'referenced-folder-membership', 'folder-allowed',
      'primary', 'session', 'referenced-session'
    ), (
      'referenced-task-membership', 'task-primary',
      'reference', 'session', 'referenced-session'
    )
  `;
  await sql`UPDATE sessions SET folder_id = 'task-primary'
    WHERE session_id IN ('task-session', 'actual-work-session', 'source-item-session')`;
  await sql`
    UPDATE sessions SET card_id = 'source-item'
    WHERE session_id = 'source-item-session'
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
  await waitForNoBackend(sql, pid);
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
  throw new Error("request-owned search backend did not exit after cancel or discard");
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

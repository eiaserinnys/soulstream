import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";
import {
  readDocumentDifferences,
  readPostingDifferences,
  readPostingShape,
  readSearchStatistics,
  runBackfill,
} from "./event_search_postings_mirror_postgres_helpers.js";

const MIGRATION_132_PATH = fileURLToPath(new URL(
  "../../../packages/db-schema/sql/migrations/132_event_search_integer_postings.sql",
  import.meta.url,
));
const MIGRATION_133_PATH = fileURLToPath(new URL(
  "../../../packages/db-schema/sql/migrations/133_event_search_documents.sql",
  import.meta.url,
));
const MIGRATION_134_PATH = fileURLToPath(new URL(
  "../../../packages/db-schema/sql/migrations/134_event_search_read_v2.sql",
  import.meta.url,
));
const describePostgres = hasFullSchemaPostgresBackend ? describe.sequential : describe.skip;

describePostgres("integer event-search postings migration and backfill", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("upgrades 132 idempotently and mirrors postings with document metadata", async () => {
    const freshShape = await readPostingShape(harness.sql);
    const migration132 = readFileSync(MIGRATION_132_PATH, "utf8");
    const migration133 = readFileSync(MIGRATION_133_PATH, "utf8");
    const migration134 = readFileSync(MIGRATION_134_PATH, "utf8");

    await harness.sql.unsafe(`
      DROP TRIGGER IF EXISTS trg_event_search_postings_insert ON event_search_terms;
      DROP TRIGGER IF EXISTS trg_event_search_postings_update ON event_search_terms;
      DROP TRIGGER IF EXISTS trg_event_search_postings_delete ON event_search_terms;
      DROP FUNCTION IF EXISTS mirror_event_search_postings();
      DROP TABLE IF EXISTS event_search_documents;
      DROP TABLE IF EXISTS event_search_postings;
      DROP TABLE IF EXISTS event_search_event_types;
      DROP TABLE IF EXISTS event_search_dictionary;
      DROP TABLE IF EXISTS event_search_session_keys;
    `);
    await harness.sql.unsafe(migration132);
    await harness.sql.unsafe(migration133);
    await harness.sql.unsafe(migration133);
    await harness.sql.unsafe(migration134);
    expect(await readPostingShape(harness.sql)).toEqual(freshShape);

    await harness.sql`
      INSERT INTO sessions (session_id, session_type, status)
      VALUES ('postings-mirror-a', 'codex', 'running'),
             ('postings-mirror-b', 'codex', 'running')
    `;
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload, searchable_text, created_at)
      VALUES ('postings-mirror-a', 1, 'user_message', '{}', '디스크 디스크 위생 alpha',
                '2026-10-28T00:00:00Z'),
             ('postings-mirror-a', 2, 'assistant_message', '{}', 'beta gamma', NULL),
             ('postings-mirror-b', 1, 'tool_call', '{}', 'gamma delta', '2026-10-27T00:00:00Z')
    `;
    await harness.sql`
      UPDATE events
      SET searchable_text = '디스크 크론 크론 beta',
          event_type = 'assistant_message',
          created_at = '2026-10-29T04:00:00Z'
      WHERE session_id = 'postings-mirror-a' AND id = 1
    `;
    await harness.sql`
      DELETE FROM events WHERE session_id = 'postings-mirror-a' AND id = 2
    `;
    await harness.sql`DELETE FROM sessions WHERE session_id = 'postings-mirror-b'`;

    expect(await readPostingDifferences(harness.sql)).toEqual({
      missing: 0,
      extra: 0,
      changed: 0,
    });
    expect(await readDocumentDifferences(harness.sql)).toEqual({
      missing: 0,
      extra: 0,
      changed: 0,
      orphanPostings: 0,
    });
    expect(await readSearchStatistics(harness.sql)).toEqual({
      dfMismatch: 0,
      corpusDocs: 1,
      expectedDocs: 1,
      corpusDocLength: 4,
      expectedDocLength: 4,
    });
    const retainedKeys = await harness.sql<Array<{ session_id: string }>>`
      SELECT session_id FROM event_search_session_keys ORDER BY session_id
    `;
    expect(retainedKeys).toEqual([
      { session_id: "postings-mirror-a" },
      { session_id: "postings-mirror-b" },
    ]);
  });

  it("backfills legacy rows and resumes after changes on both sides of its checkpoint", async () => {
    const checkpointDirectory = mkdtempSync(join(tmpdir(), "event-search-postings-"));
    const backfillCheckpoint = join(checkpointDirectory, "backfill.json");
    const verifyCheckpoint = join(checkpointDirectory, "verify.json");
    try {
      await harness.sql`
        INSERT INTO sessions (session_id, session_type, status)
        VALUES ('postings-backfill', 'codex', 'running')
      `;
      await harness.sql.unsafe(`
        DROP TRIGGER trg_event_search_postings_insert ON event_search_terms;
        DROP TRIGGER trg_event_search_postings_update ON event_search_terms;
        DROP TRIGGER trg_event_search_postings_delete ON event_search_terms;
      `);
      await harness.sql`
        INSERT INTO events (session_id, id, event_type, payload, searchable_text)
        VALUES ('postings-backfill', 1, 'backfill_message', '{}', 'old alpha'),
               ('postings-backfill', 2, 'backfill_message', '{}', 'old beta'),
               ('postings-backfill', 3, 'backfill_message', '{}', 'old gamma'),
               ('postings-backfill', 4, 'backfill_message', '{}', 'old delta')
      `;
      await harness.sql`TRUNCATE event_search_postings`;
      await harness.sql`DELETE FROM event_search_documents`;
      await harness.sql.unsafe(readFileSync(MIGRATION_133_PATH, "utf8"));

      const firstRun = runBackfill(
        "backfill", backfillCheckpoint, harness.databaseUrl,
        "--batch-events", "2", "--max-seconds", "0",
      );
      expect(firstRun.status, firstRun.stderr || firstRun.stdout).toBe(0);
      expect(firstRun.stdout).toContain("processedEvents");
      expectNoDatabaseUrl(firstRun, harness.databaseUrl);
      const saved = JSON.parse(readFileSync(backfillCheckpoint, "utf8")) as {
        version: number;
        lastSessionId: string;
        lastEventId: number;
      };
      expect(saved).toMatchObject({
        version: 2,
        command: "backfill",
        lastSessionId: "postings-backfill",
        lastEventId: 2,
      });

      await harness.sql`
        UPDATE events SET searchable_text = 'changed alpha'
        WHERE session_id = 'postings-backfill' AND id = 1
      `;
      await harness.sql`
        DELETE FROM events WHERE session_id = 'postings-backfill' AND id = 2
      `;
      await harness.sql`
        UPDATE events SET searchable_text = 'changed gamma gamma'
        WHERE session_id = 'postings-backfill' AND id = 3
      `;
      await harness.sql`
        DELETE FROM events WHERE session_id = 'postings-backfill' AND id = 4
      `;

      const resumed = runBackfill("backfill", backfillCheckpoint, harness.databaseUrl,
        "--batch-events", "1");
      expect(resumed.status, resumed.stderr || resumed.stdout).toBe(0);
      expectNoDatabaseUrl(resumed, harness.databaseUrl);
      const verified = runBackfill("verify", verifyCheckpoint, harness.databaseUrl,
        "--batch-events", "1");
      expect(verified.status, verified.stderr || verified.stdout).toBe(0);
      expect(verified.stdout).toContain('"missing":0');
      expect(verified.stdout).toContain('"extra":0');
      expect(verified.stdout).toContain('"changed":0');
      expectNoDatabaseUrl(verified, harness.databaseUrl);
      expect(await readDocumentDifferences(harness.sql)).toEqual({
        missing: 0,
        extra: 0,
        changed: 0,
        orphanPostings: 0,
      });

      const status = runBackfill("status", backfillCheckpoint, harness.databaseUrl);
      expect(status.status, status.stderr || status.stdout).toBe(0);
      expect(status.stdout).toContain("event_search_terms");
      expect(status.stdout).toContain("event_search_postings");
      expectNoDatabaseUrl(status, harness.databaseUrl);
    } finally {
      rmSync(checkpointDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("checks every legacy posting doc_len against its compact document", async () => {
    const checkpointDirectory = mkdtempSync(join(tmpdir(), "event-search-postings-doc-len-"));
    const checkpoint = join(checkpointDirectory, "verify.json");
    try {
      await harness.sql`
        INSERT INTO sessions (session_id, session_type, status)
        VALUES ('postings-doc-len-check', 'codex', 'running')
      `;
      await harness.sql`
        INSERT INTO events (session_id, id, event_type, payload, searchable_text)
        VALUES ('postings-doc-len-check', 1, 'user_message', '{}', 'lengthalpha lengthbeta')
      `;
      await harness.sql`
        UPDATE event_search_terms SET doc_len = 3
        WHERE session_id = 'postings-doc-len-check'
          AND event_id = 1
          AND term = 'lengthalpha'
      `;

      const verified = runBackfill("verify", checkpoint, harness.databaseUrl);
      expect(verified.status, verified.stderr || verified.stdout).toBe(1);
      expectNoDatabaseUrl(verified, harness.databaseUrl);
      expect(readCommandReport(verified.stdout)).toMatchObject({
        complete: true,
        differences: {
          missing: 0,
          extra: 0,
          changed: 1,
          missingDocuments: 0,
          extraDocuments: 0,
          changedDocuments: 0,
          orphanPostings: 0,
        },
      });
    } finally {
      await harness.sql`
        UPDATE event_search_terms SET doc_len = 2
        WHERE session_id = 'postings-doc-len-check' AND event_id = 1
      `;
      rmSync(checkpointDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("preserves verify results across time-limited resumes and completed reruns", async () => {
    const checkpointDirectory = mkdtempSync(join(tmpdir(), "event-search-postings-verify-"));
    const cleanCheckpoint = join(checkpointDirectory, "clean-verify.json");
    const mismatchCheckpoint = join(checkpointDirectory, "mismatch-verify.json");
    const oldCheckpoint = join(checkpointDirectory, "old-verify.json");
    try {
      await harness.sql`
        INSERT INTO sessions (session_id, session_type, status)
        VALUES ('aaa-postings-verify', 'codex', 'running')
      `;
      await harness.sql`
        INSERT INTO events (session_id, id, event_type, payload, searchable_text)
        VALUES ('aaa-postings-verify', 1, 'user_message', '{}', 'verifyalpha'),
               ('aaa-postings-verify', 2, 'user_message', '{}', 'verifybravo'),
               ('aaa-postings-verify', 3, 'user_message', '{}', 'verifycharlie')
      `;

      const interruptedClean = runBackfill("verify", cleanCheckpoint, harness.databaseUrl,
        "--batch-events", "1", "--max-seconds", "0");
      expect(interruptedClean.status, interruptedClean.stderr || interruptedClean.stdout).toBe(0);
      const interruptedCleanReport = readCommandReport(interruptedClean.stdout);
      expect(interruptedCleanReport).toMatchObject({
        complete: false,
        timeLimitReached: true,
        comparedEvents: 1,
        comparedPostings: 1,
        differences: { missing: 0, extra: 0, changed: 0 },
      });

      const completedClean = runBackfill("verify", cleanCheckpoint, harness.databaseUrl,
        "--batch-events", "1");
      expect(completedClean.status, completedClean.stderr || completedClean.stdout).toBe(0);
      expect(readCommandReport(completedClean.stdout)).toMatchObject({
        complete: true,
        timeLimitReached: false,
        differences: { missing: 0, extra: 0, changed: 0 },
      });
      expect(readCommandReport(completedClean.stdout).comparedEvents)
        .toBeGreaterThan(interruptedCleanReport.comparedEvents);

      writeFileSync(oldCheckpoint, JSON.stringify({
        version: 1,
        command: "verify",
        lastSessionId: null,
        lastEventId: null,
      }), "utf8");
      const rejectedOldCheckpoint = runBackfill("verify", oldCheckpoint, harness.databaseUrl);
      expect(rejectedOldCheckpoint.status).toBe(1);
      expect(rejectedOldCheckpoint.stderr).toContain("version 2 verify checkpoint");
      expectNoDatabaseUrl(rejectedOldCheckpoint, harness.databaseUrl);

      await harness.sql`
        DELETE FROM event_search_postings posting
        USING event_search_session_keys session_key
        WHERE posting.session_key = session_key.session_key
          AND session_key.session_id = 'aaa-postings-verify'
          AND posting.event_id = 1
      `;
      await harness.sql`
        UPDATE event_search_documents document
        SET doc_len = doc_len + 1
        FROM event_search_session_keys session_key
        WHERE document.session_key = session_key.session_key
          AND session_key.session_id = 'aaa-postings-verify'
          AND document.event_id = 1
      `;
      await harness.sql`
        DELETE FROM event_search_documents document
        USING event_search_session_keys session_key
        WHERE document.session_key = session_key.session_key
          AND session_key.session_id = 'aaa-postings-verify'
          AND document.event_id = 2
      `;
      await harness.sql`
        UPDATE events SET searchable_text = ''
        WHERE session_id = 'aaa-postings-verify' AND id = 3
      `;
      await harness.sql`
        INSERT INTO event_search_documents (
          session_key, event_id, doc_len, event_type_id, created_at
        )
        SELECT key.session_key, event.id, 0, event_type.event_type_id, event.created_at
        FROM events event
        JOIN event_search_session_keys key USING (session_id)
        JOIN event_search_event_types event_type USING (event_type)
        WHERE event.session_id = 'aaa-postings-verify' AND event.id = 3
      `;

      const firstMismatch = runBackfill("verify", mismatchCheckpoint, harness.databaseUrl,
        "--batch-events", "1", "--max-seconds", "0");
      expect(firstMismatch.status, firstMismatch.stderr || firstMismatch.stdout).toBe(1);
      expectNoDatabaseUrl(firstMismatch, harness.databaseUrl);
      const firstMismatchReport = readCommandReport(firstMismatch.stdout);
      expect(firstMismatchReport).toMatchObject({
        complete: false,
        timeLimitReached: true,
        comparedEvents: 1,
        comparedPostings: 1,
        differences: {
          missing: 1, extra: 0, changed: 0, changedDocuments: 1,
        },
      });
      expect(JSON.parse(readFileSync(mismatchCheckpoint, "utf8"))).toMatchObject({
        comparedEvents: 1,
        comparedPostings: 1,
        differences: {
          missing: 1, extra: 0, changed: 0, changedDocuments: 1,
        },
      });

      const resumedMismatch = runBackfill("verify", mismatchCheckpoint, harness.databaseUrl,
        "--batch-events", "1");
      expect(resumedMismatch.status, resumedMismatch.stderr || resumedMismatch.stdout).toBe(1);
      expectNoDatabaseUrl(resumedMismatch, harness.databaseUrl);
      const resumedMismatchReport = readCommandReport(resumedMismatch.stdout);
      expect(resumedMismatchReport).toMatchObject({
        complete: true,
        timeLimitReached: false,
        differences: {
          missing: 1, extra: 0, changed: 0, changedDocuments: 1,
          missingDocuments: 1, extraDocuments: 1, orphanPostings: 1,
        },
      });
      expect(resumedMismatchReport.comparedEvents).toBeGreaterThan(
        firstMismatchReport.comparedEvents,
      );
      expect(resumedMismatchReport.comparedPostings).toBeGreaterThan(
        firstMismatchReport.comparedPostings,
      );

      const completedMismatchRerun = runBackfill("verify", mismatchCheckpoint, harness.databaseUrl,
        "--batch-events", "1");
      expect(completedMismatchRerun.status, completedMismatchRerun.stderr
        || completedMismatchRerun.stdout).toBe(1);
      expect(readCommandReport(completedMismatchRerun.stdout)).toMatchObject({
        complete: true,
        comparedEvents: resumedMismatchReport.comparedEvents,
        comparedPostings: resumedMismatchReport.comparedPostings,
        differences: {
          missing: 1, extra: 0, changed: 0, changedDocuments: 1,
          missingDocuments: 1, extraDocuments: 1, orphanPostings: 1,
        },
      });
    } finally {
      rmSync(checkpointDirectory, { recursive: true, force: true });
    }
  }, 60_000);
});

function readCommandReport(stdout: string): {
  complete: boolean;
  timeLimitReached: boolean;
  comparedEvents: number;
  comparedPostings: number;
  differences: { missing: number; extra: number; changed: number };
} {
  const lines = stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]);
}

function expectNoDatabaseUrl(result: { stdout: string; stderr: string }, databaseUrl: string) {
  expect(result.stdout).not.toContain(databaseUrl);
  expect(result.stderr).not.toContain(databaseUrl);
}

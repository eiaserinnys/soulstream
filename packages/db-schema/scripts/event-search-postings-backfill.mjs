#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import dotenv from "dotenv";
import postgres from "postgres";

import { formatMigrationError } from "./migrate.mjs";
import {
  readDatabaseUrl,
  releaseServiceEnvironmentPath,
} from "./migration-contract.mjs";

const DEFAULT_BATCH_EVENTS = 200;
const DEFAULT_MAX_SECONDS = 540;
const CHECKPOINT_VERSION = 1;
const PROGRESS_INTERVAL_BATCHES = 25;
const MAX_VERIFY_SAMPLES = 10;

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!new Set(["backfill", "verify", "status"]).has(command)) {
    throw new Error("command must be backfill, verify, or status");
  }

  const options = {
    checkpoint: null,
    maxSeconds: DEFAULT_MAX_SECONDS,
    batchEvents: DEFAULT_BATCH_EVENTS,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    if (flag === "--checkpoint") {
      options.checkpoint = value;
    } else if (flag === "--max-seconds") {
      options.maxSeconds = Number(value);
      if (!Number.isFinite(options.maxSeconds) || options.maxSeconds < 0) {
        throw new Error("--max-seconds must be a non-negative number");
      }
    } else if (flag === "--batch-events") {
      options.batchEvents = Number(value);
      if (!Number.isSafeInteger(options.batchEvents) || options.batchEvents < 1) {
        throw new Error("--batch-events must be a positive integer");
      }
    } else {
      throw new Error(`unknown option: ${flag}`);
    }
    index += 1;
  }
  if (!options.checkpoint) throw new Error("--checkpoint is required");
  options.checkpoint = resolve(options.checkpoint);
  return { command, ...options };
}

export async function run(command, options, { env = process.env, cwd = process.cwd() } = {}) {
  dotenv.config({
    path: releaseServiceEnvironmentPath(env, cwd),
    override: true,
    processEnv: env,
  });
  const sql = postgres(readDatabaseUrl(env), {
    max: 1,
    idle_timeout: 1,
    connect_timeout: 5,
  });

  try {
    if (command === "status") return await readStatus(sql, options.checkpoint);
    const checkpoint = await readCheckpoint(options.checkpoint, command);
    if (command === "backfill") {
      return await runBackfill(sql, options, checkpoint);
    }
    return await runVerify(sql, options, checkpoint);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function readCheckpoint(path, command) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { version: CHECKPOINT_VERSION, command, lastSessionId: null, lastEventId: null };
    }
    throw error;
  }
  const checkpoint = JSON.parse(contents);
  if (checkpoint.version !== CHECKPOINT_VERSION || checkpoint.command !== command) {
    throw new Error(`checkpoint is not a version ${CHECKPOINT_VERSION} ${command} checkpoint`);
  }
  if ((checkpoint.lastSessionId === null) !== (checkpoint.lastEventId === null)) {
    throw new Error("checkpoint event key is incomplete");
  }
  if (checkpoint.lastSessionId !== null && !Number.isSafeInteger(checkpoint.lastEventId)) {
    throw new Error("checkpoint event id is invalid");
  }
  return checkpoint;
}

async function writeCheckpoint(path, checkpoint) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function selectEvents(tx, checkpoint, batchEvents, lock) {
  const lockClause = lock ? " FOR UPDATE" : "";
  if (checkpoint.lastSessionId === null) {
    return await tx.unsafe(`
      SELECT session_id, id
      FROM events
      ORDER BY session_id, id
      LIMIT $1${lockClause}
    `, [batchEvents]);
  }
  return await tx.unsafe(`
    SELECT session_id, id
    FROM events
    WHERE (session_id, id) > ($1, $2)
    ORDER BY session_id, id
    LIMIT $3${lockClause}
  `, [checkpoint.lastSessionId, checkpoint.lastEventId, batchEvents]);
}

async function runBackfill(sql, options, initialCheckpoint) {
  const startedAt = Date.now();
  let checkpoint = initialCheckpoint;
  let processedEvents = 0;
  let insertedPostings = 0;
  let batches = 0;
  let totalBatchMs = 0;
  let maxBatchMs = 0;
  let complete = false;
  let timeLimitReached = false;

  while (!complete) {
    const batchStartedAt = Date.now();
    const events = await sql.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`;
      const selected = await selectEvents(tx, checkpoint, options.batchEvents, true);
      if (selected.length === 0) return selected;

      const sessionIds = selected.map((event) => event.session_id);
      const eventIds = selected.map((event) => event.id);
      await insertMissingMappings(tx, sessionIds, eventIds);
      await tx`
        DELETE FROM event_search_postings posting
        USING unnest(${sessionIds}::text[], ${eventIds}::int[])
          AS selected(session_id, event_id)
        JOIN event_search_session_keys session_key
          ON session_key.session_id = selected.session_id
        WHERE posting.session_key = session_key.session_key
          AND posting.event_id = selected.event_id
      `;
      const inserted = await tx`
        INSERT INTO event_search_postings (
          session_key, event_id, term_id, term_freq, doc_len
        )
        SELECT session_key.session_key,
               legacy.event_id,
               dictionary.term_id,
               legacy.term_freq,
               legacy.doc_len
        FROM event_search_terms legacy
        JOIN unnest(${sessionIds}::text[], ${eventIds}::int[])
          AS selected(session_id, event_id)
          ON selected.session_id = legacy.session_id
         AND selected.event_id = legacy.event_id
        JOIN event_search_session_keys session_key
          ON session_key.session_id = legacy.session_id
        JOIN event_search_dictionary dictionary
          ON dictionary.term = legacy.term
        ORDER BY dictionary.term_id, session_key.session_key, legacy.event_id
      `;
      return { events: selected, postingCount: inserted.count };
    });

    if (events.length === 0) {
      complete = true;
      await writeCheckpoint(options.checkpoint, { ...checkpoint, complete: true });
      break;
    }

    const selectedEvents = events.events;
    const lastEvent = selectedEvents[selectedEvents.length - 1];
    checkpoint = {
      version: CHECKPOINT_VERSION,
      command: "backfill",
      lastSessionId: lastEvent.session_id,
      lastEventId: lastEvent.id,
    };
    await writeCheckpoint(options.checkpoint, checkpoint);
    processedEvents += selectedEvents.length;
    insertedPostings += events.postingCount;
    batches += 1;
    const batchMs = Date.now() - batchStartedAt;
    totalBatchMs += batchMs;
    maxBatchMs = Math.max(maxBatchMs, batchMs);

    if (batches % PROGRESS_INTERVAL_BATCHES === 0) {
      writeProgress({ batches, processedEvents, insertedPostings, elapsedMs: Date.now() - startedAt,
        averageBatchMs: totalBatchMs / batches, maxBatchMs, checkpoint });
    }
    if (Date.now() - startedAt >= options.maxSeconds * 1000) {
      timeLimitReached = true;
      break;
    }
  }

  writeProgress({ batches, processedEvents, insertedPostings, elapsedMs: Date.now() - startedAt,
    averageBatchMs: batches ? totalBatchMs / batches : 0, maxBatchMs, checkpoint, complete,
    timeLimitReached });
  return { status: "ok", command: "backfill", ...checkpoint, batches, processedEvents,
    insertedPostings, elapsedMs: Date.now() - startedAt, complete, timeLimitReached };
}

async function insertMissingMappings(tx, sessionIds, eventIds) {
  await tx`
    INSERT INTO event_search_session_keys (session_id)
    SELECT candidates.session_id
    FROM (
      SELECT DISTINCT legacy.session_id
      FROM event_search_terms legacy
      JOIN unnest(${sessionIds}::text[], ${eventIds}::int[])
        AS selected(session_id, event_id)
        ON selected.session_id = legacy.session_id
       AND selected.event_id = legacy.event_id
    ) candidates
    WHERE NOT EXISTS (
      SELECT 1 FROM event_search_session_keys existing
      WHERE existing.session_id = candidates.session_id
    )
    ORDER BY candidates.session_id COLLATE "C"
    ON CONFLICT (session_id) DO NOTHING
  `;
  await tx`
    INSERT INTO event_search_dictionary (term)
    SELECT candidates.term
    FROM (
      SELECT DISTINCT legacy.term
      FROM event_search_terms legacy
      JOIN unnest(${sessionIds}::text[], ${eventIds}::int[])
        AS selected(session_id, event_id)
        ON selected.session_id = legacy.session_id
       AND selected.event_id = legacy.event_id
    ) candidates
    WHERE NOT EXISTS (
      SELECT 1 FROM event_search_dictionary existing
      WHERE existing.term = candidates.term
    )
    ORDER BY candidates.term COLLATE "C"
    ON CONFLICT (term) DO NOTHING
  `;
}

async function runVerify(sql, options, initialCheckpoint) {
  const startedAt = Date.now();
  let checkpoint = initialCheckpoint;
  let comparedEvents = 0;
  const differences = { missing: 0, extra: 0, changed: 0 };
  const samples = [];
  let batches = 0;
  let complete = false;

  while (!complete) {
    const result = await sql.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
      const events = await selectEvents(tx, checkpoint, options.batchEvents, false);
      if (events.length === 0) return { events, differences: null, samples: [] };
      const sessionIds = events.map((event) => event.session_id);
      const eventIds = events.map((event) => event.id);
      const batchDifferences = await countDifferences(tx, sessionIds, eventIds);
      const batchSamples = samples.length < MAX_VERIFY_SAMPLES
        ? await readDifferenceSamples(tx, sessionIds, eventIds, MAX_VERIFY_SAMPLES - samples.length)
        : [];
      return { events, differences: batchDifferences, samples: batchSamples };
    });

    if (result.events.length === 0) {
      complete = true;
      await writeCheckpoint(options.checkpoint, { ...checkpoint, complete: true });
      break;
    }

    const lastEvent = result.events[result.events.length - 1];
    checkpoint = {
      version: CHECKPOINT_VERSION,
      command: "verify",
      lastSessionId: lastEvent.session_id,
      lastEventId: lastEvent.id,
    };
    await writeCheckpoint(options.checkpoint, checkpoint);
    comparedEvents += result.events.length;
    batches += 1;
    for (const key of Object.keys(differences)) differences[key] += result.differences[key];
    samples.push(...result.samples);
    if (batches % PROGRESS_INTERVAL_BATCHES === 0) {
      writeProgress({ batches, comparedEvents, differences, elapsedMs: Date.now() - startedAt,
        checkpoint });
    }
  }

  const totalDifferences = differences.missing + differences.extra + differences.changed;
  const report = { status: totalDifferences === 0 ? "ok" : "differences_found", command: "verify",
    ...checkpoint, batches, comparedEvents, differences, samples, elapsedMs: Date.now() - startedAt };
  return report;
}

async function countDifferences(tx, sessionIds, eventIds) {
  const [row] = await tx`
    WITH selected AS (
      SELECT session_id, event_id
      FROM unnest(${sessionIds}::text[], ${eventIds}::int[]) AS item(session_id, event_id)
    ), legacy AS (
      SELECT terms.session_id, terms.event_id, terms.term, terms.term_freq, terms.doc_len
      FROM event_search_terms terms JOIN selected USING (session_id, event_id)
    ), compact AS (
      SELECT keys.session_id, posting.event_id, dictionary.term,
             posting.term_freq, posting.doc_len
      FROM event_search_postings posting
      JOIN event_search_session_keys keys USING (session_key)
      JOIN event_search_dictionary dictionary USING (term_id)
      JOIN selected ON selected.session_id = keys.session_id
                   AND selected.event_id = posting.event_id
    ), compared AS (
      SELECT legacy.term_freq AS legacy_tf, legacy.doc_len AS legacy_len,
             compact.term_freq AS compact_tf, compact.doc_len AS compact_len
      FROM legacy FULL JOIN compact USING (session_id, event_id, term)
    )
    SELECT COUNT(*) FILTER (WHERE legacy_tf IS NOT NULL AND compact_tf IS NULL)::int AS missing,
           COUNT(*) FILTER (WHERE legacy_tf IS NULL AND compact_tf IS NOT NULL)::int AS extra,
           COUNT(*) FILTER (
             WHERE legacy_tf IS NOT NULL AND compact_tf IS NOT NULL
               AND (legacy_tf, legacy_len) IS DISTINCT FROM (compact_tf, compact_len)
           )::int AS changed
    FROM compared
  `;
  return row;
}

async function readDifferenceSamples(tx, sessionIds, eventIds, limit) {
  return await tx`
    WITH selected AS (
      SELECT session_id, event_id
      FROM unnest(${sessionIds}::text[], ${eventIds}::int[]) AS item(session_id, event_id)
    ), legacy AS (
      SELECT terms.session_id, terms.event_id, terms.term, terms.term_freq, terms.doc_len
      FROM event_search_terms terms JOIN selected USING (session_id, event_id)
    ), compact AS (
      SELECT keys.session_id, posting.event_id, dictionary.term,
             posting.term_freq, posting.doc_len
      FROM event_search_postings posting
      JOIN event_search_session_keys keys USING (session_key)
      JOIN event_search_dictionary dictionary USING (term_id)
      JOIN selected ON selected.session_id = keys.session_id
                   AND selected.event_id = posting.event_id
    ), compared AS (
      SELECT COALESCE(legacy.session_id, compact.session_id) AS session_id,
             COALESCE(legacy.event_id, compact.event_id) AS event_id,
             COALESCE(legacy.term, compact.term) AS term,
             legacy.term_freq AS legacy_tf, legacy.doc_len AS legacy_len,
             compact.term_freq AS compact_tf, compact.doc_len AS compact_len
      FROM legacy FULL JOIN compact USING (session_id, event_id, term)
    )
    SELECT CASE
             WHEN legacy_tf IS NULL THEN 'extra'
             WHEN compact_tf IS NULL THEN 'missing'
             ELSE 'changed'
           END AS kind,
           session_id AS "sessionId", event_id AS "eventId", term,
           legacy_tf AS "legacyTermFreq", legacy_len AS "legacyDocLen",
           compact_tf AS "compactTermFreq", compact_len AS "compactDocLen"
    FROM compared
    WHERE legacy_tf IS NULL OR compact_tf IS NULL
       OR (legacy_tf, legacy_len) IS DISTINCT FROM (compact_tf, compact_len)
    ORDER BY session_id, event_id, term
    LIMIT ${limit}
  `;
}

async function readStatus(sql, checkpointPath) {
  const checkpoint = await readFile(checkpointPath, "utf8")
    .then((text) => JSON.parse(text), (error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
  const tables = await sql`
    SELECT relation.relname AS table_name,
           relation.reltuples::bigint AS estimated_rows,
           pg_total_relation_size(relation.oid)::text AS total_bytes
    FROM pg_class relation
    WHERE relation.oid IN (
      to_regclass('event_search_terms'),
      to_regclass('event_search_postings')
    )
    ORDER BY relation.relname
  `;
  return { status: "ok", command: "status", checkpointPath, checkpoint, tables };
}

function writeProgress(progress) {
  console.log(JSON.stringify({ type: "progress", ...progress }));
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = await run(options.command, options);
    console.log(JSON.stringify(report));
    if (options.command === "verify"
        && (report.differences.missing + report.differences.extra + report.differences.changed) > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(formatMigrationError(error, process.env));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

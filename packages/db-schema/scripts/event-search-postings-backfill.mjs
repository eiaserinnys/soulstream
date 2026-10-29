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
import {
  countDifferences,
  insertMissingMappings,
  readDifferenceSamples,
  readDocumentDifferenceSamples,
} from "./event-search-postings-backfill-queries.mjs";

const DEFAULT_BATCH_EVENTS = 200;
const DEFAULT_MAX_SECONDS = 540;
const CHECKPOINT_VERSION = 2;
const PROGRESS_INTERVAL_BATCHES = 25;
const MAX_VERIFY_SAMPLES = 10;
const VERIFY_DIFFERENCE_KEYS = [
  "missing", "extra", "changed", "missingDocuments", "extraDocuments",
  "changedDocuments", "orphanPostings",
];

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
    const [legacy] = await sql`SELECT to_regclass('event_search_terms') AS relation`;
    if (!legacy.relation) {
      throw new Error("event_search_terms is absent; backfill and verify retired after the v2 write switch");
    }
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
      SELECT session_id, id, event_type, created_at
      FROM events
      ORDER BY session_id, id
      LIMIT $1${lockClause}
    `, [batchEvents]);
  }
  return await tx.unsafe(`
    SELECT session_id, id, event_type, created_at
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
  let insertedDocuments = 0;
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
      await tx`
        DELETE FROM event_search_documents document
        USING unnest(${sessionIds}::text[], ${eventIds}::int[])
          AS selected(session_id, event_id)
        JOIN event_search_session_keys session_key
          ON session_key.session_id = selected.session_id
        WHERE document.session_key = session_key.session_key
          AND document.event_id = selected.event_id
      `;
      const insertedDocs = await tx`
        INSERT INTO event_search_documents (
          session_key, event_id, doc_len, event_type_id, created_at
        )
        SELECT session_key.session_key,
               legacy.event_id,
               MAX(legacy.doc_len)::int,
               event_type.event_type_id,
               event.created_at
        FROM event_search_terms legacy
        JOIN unnest(${sessionIds}::text[], ${eventIds}::int[])
          AS selected(session_id, event_id)
          ON selected.session_id = legacy.session_id
         AND selected.event_id = legacy.event_id
        JOIN event_search_session_keys session_key
          ON session_key.session_id = legacy.session_id
        JOIN events event
          ON event.session_id = legacy.session_id
         AND event.id = legacy.event_id
        JOIN event_search_event_types event_type
          ON event_type.event_type = event.event_type
        GROUP BY session_key.session_key, legacy.event_id,
                 event_type.event_type_id, event.created_at
        ORDER BY session_key.session_key, legacy.event_id
      `;
      const inserted = await tx`
        INSERT INTO event_search_postings (
          session_key, event_id, term_id, term_freq
        )
        SELECT session_key.session_key,
               legacy.event_id,
               dictionary.term_id,
               legacy.term_freq
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
      return {
        events: selected,
        documentCount: insertedDocs.count,
        postingCount: inserted.count,
      };
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
    insertedDocuments += events.documentCount;
    batches += 1;
    const batchMs = Date.now() - batchStartedAt;
    totalBatchMs += batchMs;
    maxBatchMs = Math.max(maxBatchMs, batchMs);

    if (batches % PROGRESS_INTERVAL_BATCHES === 0) {
      writeProgress({ batches, processedEvents, insertedDocuments, insertedPostings,
        elapsedMs: Date.now() - startedAt,
        averageBatchMs: totalBatchMs / batches, maxBatchMs, checkpoint });
    }
    if (Date.now() - startedAt >= options.maxSeconds * 1000) {
      timeLimitReached = true;
      break;
    }
  }

  writeProgress({ batches, processedEvents, insertedDocuments, insertedPostings,
    elapsedMs: Date.now() - startedAt,
    averageBatchMs: batches ? totalBatchMs / batches : 0, maxBatchMs, checkpoint, complete,
    timeLimitReached });
  return { status: "ok", command: "backfill", ...checkpoint, batches, processedEvents,
    insertedDocuments, insertedPostings, elapsedMs: Date.now() - startedAt, complete,
    timeLimitReached };
}

async function runVerify(sql, options, initialCheckpoint) {
  const startedAt = Date.now();
  let checkpoint = restoreVerifyCheckpoint(initialCheckpoint);
  let batches = 0;
  let complete = checkpoint.complete === true;
  let timeLimitReached = false;

  while (!complete) {
    const result = await sql.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
      const events = await selectEvents(tx, checkpoint, options.batchEvents, false);
      if (events.length === 0) return { events, differences: null, samples: [] };
      const sessionIds = events.map((event) => event.session_id);
      const eventIds = events.map((event) => event.id);
      const batchDifferences = await countDifferences(tx, sessionIds, eventIds);
      const sampleLimit = MAX_VERIFY_SAMPLES - checkpoint.samples.length;
      const postingSamples = sampleLimit > 0
        ? await readDifferenceSamples(tx, sessionIds, eventIds, sampleLimit)
        : [];
      const documentSamples = sampleLimit > postingSamples.length
        ? await readDocumentDifferenceSamples(tx, sessionIds, eventIds,
          sampleLimit - postingSamples.length)
        : [];
      const batchSamples = [...postingSamples, ...documentSamples];
      return { events, differences: batchDifferences, samples: batchSamples };
    });

    if (result.events.length === 0) {
      complete = true;
      checkpoint = { ...checkpoint, complete: true };
      await writeCheckpoint(options.checkpoint, checkpoint);
      break;
    }

    const lastEvent = result.events[result.events.length - 1];
    checkpoint = {
      ...checkpoint,
      version: CHECKPOINT_VERSION,
      command: "verify",
      lastSessionId: lastEvent.session_id,
      lastEventId: lastEvent.id,
      comparedEvents: checkpoint.comparedEvents + result.events.length,
      comparedPostings: checkpoint.comparedPostings + result.differences.comparedPostings,
      comparedDocuments: checkpoint.comparedDocuments + result.differences.comparedDocuments,
      differences: Object.fromEntries(VERIFY_DIFFERENCE_KEYS.map((key) => [
        key, checkpoint.differences[key] + result.differences[key],
      ])),
      samples: [...checkpoint.samples, ...result.samples].slice(0, MAX_VERIFY_SAMPLES),
      complete: false,
    };
    await writeCheckpoint(options.checkpoint, checkpoint);
    batches += 1;
    if (batches % PROGRESS_INTERVAL_BATCHES === 0) {
      writeProgress({ batches, comparedEvents: checkpoint.comparedEvents,
        comparedPostings: checkpoint.comparedPostings,
        comparedDocuments: checkpoint.comparedDocuments,
        differences: checkpoint.differences,
        elapsedMs: Date.now() - startedAt, checkpoint });
    }
    if (Date.now() - startedAt >= options.maxSeconds * 1000) {
      timeLimitReached = true;
      break;
    }
  }

  const hasDifferences = VERIFY_DIFFERENCE_KEYS
    .some((key) => checkpoint.differences[key] > 0);
  const report = {
    status: hasDifferences ? "differences_found" : complete ? "ok" : "incomplete",
    command: "verify",
    ...checkpoint,
    batches,
    elapsedMs: Date.now() - startedAt,
    timeLimitReached,
  };
  return report;
}

function restoreVerifyCheckpoint(checkpoint) {
  const hasCumulativeResults = Number.isSafeInteger(checkpoint.comparedEvents)
    && Number.isSafeInteger(checkpoint.comparedPostings)
    && Number.isSafeInteger(checkpoint.comparedDocuments)
    && VERIFY_DIFFERENCE_KEYS.every((key) =>
      Number.isSafeInteger(checkpoint.differences?.[key]))
    && Array.isArray(checkpoint.samples);
  if (!hasCumulativeResults) {
    return {
      version: CHECKPOINT_VERSION,
      command: "verify",
      lastSessionId: null,
      lastEventId: null,
      comparedEvents: 0,
      comparedPostings: 0,
      comparedDocuments: 0,
      differences: Object.fromEntries(VERIFY_DIFFERENCE_KEYS.map((key) => [key, 0])),
      samples: [],
      complete: false,
    };
  }
  return checkpoint;
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
      to_regclass('event_search_postings'),
      to_regclass('event_search_documents'),
      to_regclass('event_search_dictionary'),
      to_regclass('event_search_event_types')
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
        && VERIFY_DIFFERENCE_KEYS.some((key) => report.differences[key] > 0)) {
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

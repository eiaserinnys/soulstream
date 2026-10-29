#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import dotenv from "dotenv";
import postgres from "postgres";

import { omitInlineImageData } from "../src/db/omit_inline_image_data.js";
import { formatMigrationError } from "../../packages/db-schema/scripts/migrate.mjs";
import {
  readDatabaseUrl,
  releaseServiceEnvironmentPath,
} from "../../packages/db-schema/scripts/migration-contract.mjs";

const DEFAULT_MAX_SECONDS = 540;
const DEFAULT_BATCH = 200;
const CHECKPOINT_VERSION = 1;
const PROGRESS_INTERVAL_BATCHES = 25;
const TARGET_EVENT_TYPES = ["tool_result", "tool_start"] as const;

interface Options {
  checkpoint: string;
  maxSeconds: number;
  batch: number;
  dryRun: boolean;
}

interface Checkpoint {
  version: number;
  dryRun: boolean;
  lastSessionId: string | null;
  lastEventId: number | null;
  processedRows: number;
  changedRows: number;
  reducedBytes: number;
  complete: boolean;
}

interface EventRow {
  session_id: string;
  id: number;
  payload: unknown;
}

interface BatchResult {
  rows: EventRow[];
  changedRows: number;
  reducedBytes: number;
}

export function parseArguments(argv: string[]): Options {
  const options: Options = {
    checkpoint: "",
    maxSeconds: DEFAULT_MAX_SECONDS,
    batch: DEFAULT_BATCH,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--checkpoint") {
      options.checkpoint = resolve(value);
    } else if (flag === "--max-seconds") {
      options.maxSeconds = Number(value);
      if (!Number.isFinite(options.maxSeconds) || options.maxSeconds < 0) {
        throw new Error("--max-seconds must be a non-negative number");
      }
    } else if (flag === "--batch") {
      options.batch = Number(value);
      if (!Number.isSafeInteger(options.batch) || options.batch < 1) {
        throw new Error("--batch must be a positive integer");
      }
    } else {
      throw new Error(`unknown option: ${flag}`);
    }
    index += 1;
  }

  if (!options.checkpoint) throw new Error("--checkpoint is required");
  return options;
}

export async function run(
  options: Options,
  { env = process.env, cwd = process.cwd() }: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {},
) {
  dotenv.config({
    path: releaseServiceEnvironmentPath(env, cwd),
    override: true,
    processEnv: env,
  });
  const checkpoint = await readCheckpoint(options.checkpoint, options.dryRun);
  const startedAt = Date.now();
  const totals = { processedRows: 0, changedRows: 0, reducedBytes: 0 };
  let batches = 0;
  let complete = checkpoint.complete;
  let timeLimitReached = false;

  if (!complete) {
    const sql = postgres(readDatabaseUrl(env), {
      max: 1,
      idle_timeout: 1,
      connect_timeout: 5,
    });
    try {
      while (!complete) {
        const batch = await processBatch(sql, checkpoint, options.batch, options.dryRun);
        if (batch.rows.length === 0) {
          complete = true;
          checkpoint.complete = true;
          await writeCheckpoint(options.checkpoint, checkpoint);
          break;
        }

        const lastRow = batch.rows[batch.rows.length - 1]!;
        checkpoint.lastSessionId = lastRow.session_id;
        checkpoint.lastEventId = lastRow.id;
        checkpoint.processedRows += batch.rows.length;
        checkpoint.changedRows += batch.changedRows;
        checkpoint.reducedBytes += batch.reducedBytes;
        await writeCheckpoint(options.checkpoint, checkpoint);

        totals.processedRows += batch.rows.length;
        totals.changedRows += batch.changedRows;
        totals.reducedBytes += batch.reducedBytes;
        batches += 1;
        if (batches % PROGRESS_INTERVAL_BATCHES === 0) {
          writeProgress({
            status: "running",
            batches,
            processedRows: checkpoint.processedRows,
            changedRows: checkpoint.changedRows,
            reducedBytes: checkpoint.reducedBytes,
            elapsedMs: Date.now() - startedAt,
            checkpoint: checkpointKey(checkpoint),
          });
        }

        if (Date.now() - startedAt >= options.maxSeconds * 1000) {
          timeLimitReached = true;
          break;
        }
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  const report = {
    status: "ok",
    processedRows: totals.processedRows,
    changedRows: totals.changedRows,
    reducedBytes: totals.reducedBytes,
    batches,
    elapsedMs: Date.now() - startedAt,
    complete,
    timeLimitReached,
    checkpoint: {
      ...checkpointKey(checkpoint),
      processedRows: checkpoint.processedRows,
      changedRows: checkpoint.changedRows,
      reducedBytes: checkpoint.reducedBytes,
      complete: checkpoint.complete,
    },
  };
  writeProgress(report);
  return report;
}

async function readCheckpoint(path: string, dryRun: boolean): Promise<Checkpoint> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        version: CHECKPOINT_VERSION,
        dryRun,
        lastSessionId: null,
        lastEventId: null,
        processedRows: 0,
        changedRows: 0,
        reducedBytes: 0,
        complete: false,
      };
    }
    throw error;
  }
  const checkpoint = JSON.parse(contents) as Checkpoint;
  if (checkpoint.version !== CHECKPOINT_VERSION || checkpoint.dryRun !== dryRun) {
    throw new Error("checkpoint version or dry-run mode does not match");
  }
  if ((checkpoint.lastSessionId === null) !== (checkpoint.lastEventId === null)) {
    throw new Error("checkpoint event key is incomplete");
  }
  if (checkpoint.lastEventId !== null && !Number.isSafeInteger(checkpoint.lastEventId)) {
    throw new Error("checkpoint event id is invalid");
  }
  return checkpoint;
}

async function writeCheckpoint(path: string, checkpoint: Checkpoint): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function processBatch(
  sql: ReturnType<typeof postgres>,
  checkpoint: Checkpoint,
  batchSize: number,
  dryRun: boolean,
): Promise<BatchResult> {
  return await sql.begin(async (tx) => {
    const { query, parameters } = buildBatchQuery(checkpoint, batchSize);
    const rows = await tx.unsafe(query, parameters) as unknown as EventRow[];
    let changedRows = 0;
    let reducedBytes = 0;
    for (const row of rows) {
      const nextPayload = omitInlineImageData(row.payload);
      if (nextPayload === row.payload) continue;

      const oldBytes = Buffer.byteLength(JSON.stringify(row.payload), "utf8");
      const nextJson = JSON.stringify(nextPayload);
      const newBytes = Buffer.byteLength(nextJson, "utf8");
      changedRows += 1;
      reducedBytes += Math.max(0, oldBytes - newBytes);
      if (!dryRun) {
        await tx.unsafe(
          "UPDATE events SET payload = $1::jsonb WHERE session_id = $2 AND id = $3",
          [tx.json(nextPayload), row.session_id, row.id],
        );
      }
    }
    return { rows, changedRows, reducedBytes };
  });
}

function buildBatchQuery(checkpoint: Checkpoint, batchSize: number) {
  const branches = TARGET_EVENT_TYPES.map((eventType) => {
    const keyPredicate = checkpoint.lastSessionId === null
      ? ""
      : `AND (session_id, event_type, id) > ($1, '${eventType}', $2)`;
    const limitParameter = checkpoint.lastSessionId === null ? "$1" : "$3";
    return `(SELECT session_id, id FROM events WHERE event_type = '${eventType}' ${keyPredicate} ORDER BY session_id, id LIMIT ${limitParameter})`;
  });
  const outerLimit = checkpoint.lastSessionId === null ? "$2" : "$4";
  return {
    query: `WITH candidates AS (${branches.join(" UNION ALL ")})
      SELECT event.session_id, event.id, event.event_type, event.payload
      FROM events AS event
      JOIN candidates USING (session_id, id)
      ORDER BY event.session_id, event.id
      LIMIT ${outerLimit}
      FOR UPDATE OF event`,
    parameters: checkpoint.lastSessionId === null
      ? [batchSize, batchSize]
      : [checkpoint.lastSessionId, checkpoint.lastEventId, batchSize, batchSize],
  };
}

function checkpointKey(checkpoint: Checkpoint) {
  return {
    lastSessionId: checkpoint.lastSessionId,
    lastEventId: checkpoint.lastEventId,
  };
}

function writeProgress(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  try {
    const options = parseArguments(process.argv.slice(2));
    await run(options);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "error", message: formatMigrationError(error) })}\n`);
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) void main();

#!/usr/bin/env node
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv, { type DotenvPopulateInput } from "dotenv";
import postgres from "postgres";
import { parseModelCatalogYaml } from "@soulstream/model-catalog";
import { processBackfillRows, type BackfillEvent, type ModelTotals } from "../src/db/backfill_codex_turn_cost.js";
import { formatMigrationError } from "../../packages/db-schema/scripts/migrate.mjs";
import { readDatabaseUrl, releaseServiceEnvironmentPath } from "../../packages/db-schema/scripts/migration-contract.mjs";

interface Options {
  checkpoint: string;
  idsFile: string;
  maxSeconds: number;
  batch: number;
  apply: boolean;
}
interface Checkpoint {
  version: 1;
  apply: boolean;
  idsFile: string;
  lastSessionId: string | null;
  lastEventId: number | null;
  processedRows: number;
  models: ModelTotals;
  complete: boolean;
}

export function parseArguments(argv: string[]): Options {
  const options: Options = { checkpoint: "", idsFile: "", maxSeconds: 540, batch: 200, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--apply") { options.apply = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--checkpoint") options.checkpoint = resolve(value);
    else if (flag === "--ids-file") options.idsFile = resolve(value);
    else if (flag === "--batch") options.batch = Number(value);
    else if (flag === "--max-seconds") options.maxSeconds = Number(value);
    else throw new Error(`unknown option: ${flag}`);
  }
  if (!options.checkpoint) throw new Error("--checkpoint is required");
  if (options.apply && !options.idsFile) throw new Error("--ids-file is required with --apply");
  if (!Number.isSafeInteger(options.batch) || options.batch < 1) throw new Error("--batch must be a positive integer");
  if (!Number.isFinite(options.maxSeconds) || options.maxSeconds < 0) throw new Error("--max-seconds must be a non-negative number");
  return options;
}

async function readCheckpoint(options: Options): Promise<Checkpoint> {
  let contents: string;
  try { contents = await readFile(options.checkpoint, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { version: 1, apply: options.apply, idsFile: options.idsFile, lastSessionId: null, lastEventId: null, processedRows: 0, models: {}, complete: false };
  }
  const checkpoint = JSON.parse(contents) as Checkpoint;
  if (checkpoint.version !== 1 || checkpoint.apply !== options.apply || checkpoint.idsFile !== options.idsFile) {
    throw new Error("checkpoint version, mode or ids file does not match");
  }
  if ((checkpoint.lastSessionId === null) !== (checkpoint.lastEventId === null)
    || (checkpoint.lastEventId !== null && !Number.isSafeInteger(checkpoint.lastEventId))) {
    throw new Error("checkpoint event key is invalid");
  }
  return checkpoint;
}

async function saveCheckpoint(path: string, checkpoint: Checkpoint): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

function buildBatchQuery(checkpoint: Checkpoint, batch: number) {
  const branches = ["complete", "error"].map((eventType) => {
    const after = checkpoint.lastSessionId === null ? "" : `AND (session_id, event_type, id) > ($1, '${eventType}', $2)`;
    const limit = checkpoint.lastSessionId === null ? "$1" : "$3";
    return `(SELECT session_id, id FROM events WHERE event_type = '${eventType}' AND jsonb_typeof(payload->'usage') = 'object' AND NOT (payload ? 'turn_cost_usd') AND NULLIF(payload->>'model', '') IS NOT NULL ${after} ORDER BY session_id, id LIMIT ${limit})`;
  });
  const outerLimit = checkpoint.lastSessionId === null ? "$2" : "$4";
  return {
    query: `WITH candidates AS (${branches.join(" UNION ALL ")})
      SELECT event.session_id, event.id, event.event_type, event.payload
      FROM events AS event JOIN candidates USING (session_id, id)
      ORDER BY event.session_id, event.id LIMIT ${outerLimit} FOR UPDATE OF event`,
    parameters: checkpoint.lastSessionId === null
      ? [batch, batch]
      : [checkpoint.lastSessionId, checkpoint.lastEventId, batch, batch],
  };
}

export async function run(options: Options, { env = process.env, cwd = process.cwd() }: {
  env?: NodeJS.ProcessEnv; cwd?: string;
} = {}) {
  dotenv.config({ path: releaseServiceEnvironmentPath(env, cwd), override: true, processEnv: env as DotenvPopulateInput });
  const catalogPath = fileURLToPath(new URL("../../packages/model-catalog/data/model-catalog.yaml", import.meta.url));
  const catalog = parseModelCatalogYaml(await readFile(catalogPath, "utf8"));
  const checkpoint = await readCheckpoint(options);
  const startedAt = Date.now();
  let batches = 0;
  if (options.apply) await mkdir(dirname(options.idsFile), { recursive: true });
  if (!checkpoint.complete) {
    const sql = postgres(readDatabaseUrl(env), { max: 1, idle_timeout: 1, connect_timeout: 5 });
    try {
      while (!checkpoint.complete) {
        const result = await sql.begin(async (tx) => {
          const { query, parameters } = buildBatchQuery(checkpoint, options.batch);
          const rows = await tx.unsafe(query, parameters) as unknown as BackfillEvent[];
          const changed: Array<{ session_id: string; id: number; turn_cost_usd: number }> = [];
          const totals = await processBackfillRows(rows, catalog, options.apply, async (row, cost) => {
            const updated = await tx.unsafe(
              "UPDATE events SET payload = jsonb_set(payload, '{turn_cost_usd}', to_jsonb($1::numeric), true) WHERE session_id = $2 AND id = $3 AND NOT (payload ? 'turn_cost_usd') RETURNING id",
              [cost, row.session_id, row.id],
            );
            if (!updated.length) return false;
            changed.push({ session_id: row.session_id, id: row.id, turn_cost_usd: cost });
            return true;
          });
          // Write the undo keys before committing, so an interrupted process cannot commit an unrecorded update.
          if (changed.length) await appendFile(options.idsFile, changed.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
          return { rows, totals };
        });
        if (!result.rows.length) {
          checkpoint.complete = true;
        } else {
          const last = result.rows[result.rows.length - 1]!;
          checkpoint.lastSessionId = last.session_id;
          checkpoint.lastEventId = last.id;
          checkpoint.processedRows += result.rows.length;
          for (const [model, value] of Object.entries(result.totals)) {
            const total = checkpoint.models[model] ?? { count: 0, cost_usd: 0 };
            total.count += value.count;
            total.cost_usd = Math.round((total.cost_usd + value.cost_usd) * 1_000_000) / 1_000_000;
            checkpoint.models[model] = total;
          }
          batches += 1;
        }
        await saveCheckpoint(options.checkpoint, checkpoint);
        if (Date.now() - startedAt >= options.maxSeconds * 1000) break;
      }
    } finally { await sql.end({ timeout: 5 }); }
  }
  const report = { status: "ok", mode: options.apply ? "apply" : "dry-run", batches, ...checkpoint, elapsedMs: Date.now() - startedAt };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

async function main(): Promise<void> {
  try { await run(parseArguments(process.argv.slice(2))); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "error", message: formatMigrationError(error) })}\n`);
    process.exitCode = 1;
  }
}
if (import.meta.url === (process.argv[1] ? pathToFileURL(process.argv[1]).href : "")) void main();

/**
 * Backfills turn summaries for completed turns that were dropped while the
 * turn-summary pipeline was disabled (see the 2026-09-15 node cutover, where
 * the gitignored `config/turn-summary.local.yaml` overlay was not carried to
 * the new host and the committed `enabled: false` default took effect).
 *
 * This is a maintenance CLI in the same shape as the other `scripts/backfill-*`
 * entries. It does NOT open a second write path: every summary is produced by
 * the canonical `TurnSummaryPipeline` and persisted through
 * `TurnSummaryRepository.appendSummary`, which goes via the `event_append()`
 * SQL function and the `dedupe_key` unique index. There is no direct INSERT.
 *
 * Usage (from orch-server-ts/):
 *   DATABASE_URL=... npx tsx scripts/backfill-turn-summaries.ts            # dry-run inventory
 *   DATABASE_URL=... npx tsx scripts/backfill-turn-summaries.ts --apply --session <id>
 *   DATABASE_URL=... npx tsx scripts/backfill-turn-summaries.ts --apply --batch 25
 *
 * The run is foreground and bounded: it processes at most `--batch` sessions
 * per invocation and records finished sessions in a state file so the next
 * invocation resumes. Re-running is always safe -- `hasSummary` plus the
 * dedupe key make every job idempotent.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import { CodexExecTurnSummarizer } from
  "../src/turn-summary/codex_exec_turn_summarizer.js";
import { resolveCodexCliPath } from "../src/turn-summary/codex_cli_path.js";
import { TurnSummaryConfigService } from
  "../src/turn-summary/turn_summary_config.js";
import { TurnSummaryPipeline } from
  "../src/turn-summary/turn_summary_pipeline.js";
import { createTurnSummaryProviderRouter } from
  "../src/turn-summary/turn_summary_provider_router.js";
import { TurnSummaryRepository } from
  "../src/turn-summary/turn_summary_repository.js";
import type { NodeRegistryEvent } from "../src/node/registry_types.js";
import type {
  LiveDbSqlResolver,
  LivePostgresSql,
} from "../src/runtime/live_db_sql.js";

// The gap is bounded by two fixed instants so repeated runs see one inventory:
//   lo = the last turn summary produced before the cutover
//   hi = the moment the restored overlay took effect (live coverage resumes)
const DEFAULT_FROM = "2026-09-15T14:24:10.388Z";
const DEFAULT_TO = "2026-09-21T00:30:00.000Z";
const DEFAULT_BATCH_SESSIONS = 25;
const DEFAULT_CONCURRENCY = 1;

interface CompleteRow {
  session_id: string;
  id: number | string;
}

interface SessionPlan {
  readonly sessionId: string;
  readonly completeEventIds: number[];
}

interface RunState {
  from: string;
  to: string;
  finishedSessionIds: string[];
}

const apply = process.argv.includes("--apply");
const onlySession = readOption("--session");
const from = readOption("--from") ?? DEFAULT_FROM;
const to = readOption("--to") ?? DEFAULT_TO;
const batchSessions = readIntOption("--batch") ?? DEFAULT_BATCH_SESSIONS;
const concurrency = readIntOption("--concurrency") ?? DEFAULT_CONCURRENCY;
const statePath = resolve(
  readOption("--state") ?? ".local/turn-summary-backfill-state.json",
);

const databaseUrl = requiredEnv("DATABASE_URL");
const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
const sqlResolver: LiveDbSqlResolver = {
  resolveSql: async () => sql as unknown as LivePostgresSql,
  close: async () => await sql.end({ timeout: 5 }),
};

try {
  // Same relative location the orchestrator resolves at runtime
  // (`production.ts` -> `../config/turn-summary.yaml`), so running this script
  // from the serving checkout reads the identical base file and the
  // `turn-summary.local.yaml` overlay beside it. `--config` exists so a
  // reviewed build outside the serving checkout can still be pointed at the
  // live configuration instead of silently using a different one.
  const configPath = readOption("--config") ?? fileURLToPath(
    new URL("../config/turn-summary.yaml", import.meta.url),
  );
  const baseConfigService = new TurnSummaryConfigService(configPath, {
    warn: (...args: unknown[]) => log("config_warning", { args }),
  });
  const baseConfig = baseConfigService.read();
  if (!baseConfig.enabled) {
    throw new Error(
      "turn summary pipeline is disabled by config; refusing to backfill",
    );
  }
  // The CLI runs its own Codex spawn limiter, so it must not claim the whole
  // live budget on top of the orchestrator's.
  const configService = {
    read: () => ({
      ...baseConfigService.read(),
      codexConcurrencyLimit: concurrency,
    }),
  };

  const plans = await buildInventory();
  const state = loadState();
  const pending = plans.filter(
    (plan) => !state.finishedSessionIds.includes(plan.sessionId),
  );
  const batch = pending.slice(0, batchSessions);

  log("inventory", {
    mode: apply ? "apply" : "dry-run",
    from,
    to,
    ...(onlySession === undefined ? {} : { session: onlySession }),
    model: baseConfig.model,
    concurrency,
    sessionsTotal: plans.length,
    completeEventsTotal: plans.reduce(
      (sum, plan) => sum + plan.completeEventIds.length,
      0,
    ),
    sessionsAlreadyFinished: plans.length - pending.length,
    sessionsThisBatch: batch.length,
    completeEventsThisBatch: batch.reduce(
      (sum, plan) => sum + plan.completeEventIds.length,
      0,
    ),
  });

  if (!apply) {
    log("dry_run_complete", {
      note: "re-run with --apply to write summaries",
    });
  } else if (batch.length === 0) {
    log("nothing_to_do", { note: "every session in range is finished" });
  } else {
    const before = await countSummaries(batch.map((plan) => plan.sessionId));
    const pipeline = await createPipeline(configService);
    await runBatch(pipeline, batch);
    // Success is measured by re-reading the database, not by counting jobs we
    // believe we enqueued.
    const after = await countSummaries(batch.map((plan) => plan.sessionId));
    const perSession = batch.map((plan) => ({
      sessionId: plan.sessionId,
      completeEvents: plan.completeEventIds.length,
      summariesBefore: before.get(plan.sessionId) ?? 0,
      summariesAfter: after.get(plan.sessionId) ?? 0,
      written:
        (after.get(plan.sessionId) ?? 0) - (before.get(plan.sessionId) ?? 0),
    }));
    const written = perSession.reduce((sum, row) => sum + row.written, 0);
    const unwritten = perSession
      .filter((row) => row.written < row.completeEvents)
      .map((row) => ({
        sessionId: row.sessionId,
        completeEvents: row.completeEvents,
        written: row.written,
      }));

    saveState({
      ...state,
      finishedSessionIds: [
        ...state.finishedSessionIds,
        ...batch.map((plan) => plan.sessionId),
      ],
    });

    log("batch_complete", {
      sessions: batch.length,
      completeEvents: batch.reduce(
        (sum, plan) => sum + plan.completeEventIds.length,
        0,
      ),
      summariesWritten: written,
      // Not an error on its own: eligibility legitimately skips agent-origin
      // turns, excluded folders and non-summarizable sessions.
      sessionsWithFewerSummariesThanTurns: unwritten.length,
      detail: unwritten.slice(0, 20),
      sessionsRemaining: pending.length - batch.length,
      statePath,
    });
  }
} finally {
  await sqlResolver.close();
}

async function buildInventory(): Promise<SessionPlan[]> {
  const rows = onlySession === undefined
    ? await sql<CompleteRow[]>`
        SELECT e.session_id, e.id
        FROM events e
        WHERE e.event_type = 'complete'
          AND e.created_at > ${from}::timestamptz
          AND e.created_at <= ${to}::timestamptz
        ORDER BY e.session_id ASC, e.id ASC
      `
    : await sql<CompleteRow[]>`
        SELECT e.session_id, e.id
        FROM events e
        WHERE e.event_type = 'complete'
          AND e.session_id = ${onlySession}
          AND e.created_at > ${from}::timestamptz
          AND e.created_at <= ${to}::timestamptz
        ORDER BY e.id ASC
      `;
  const bySession = new Map<string, number[]>();
  for (const row of rows) {
    const list = bySession.get(row.session_id) ?? [];
    list.push(Number(row.id));
    bySession.set(row.session_id, list);
  }
  return [...bySession.entries()].map(([sessionId, completeEventIds]) => ({
    sessionId,
    // Ascending complete-event order keeps each session's summaries written in
    // conversation order, so both the summary event ids and the history window
    // stay monotonic.
    completeEventIds: completeEventIds.sort((a, b) => a - b),
  }));
}

async function createPipeline(
  configService: { read: () => ReturnType<TurnSummaryConfigService["read"]> },
): Promise<TurnSummaryPipeline> {
  const codexPath = resolveCodexCliPath(process.env)?.path;
  if (codexPath === undefined) {
    throw new Error(
      "codex CLI path was not resolved from CODEX_CLI_PATH, PATH, or HOME",
    );
  }
  const codexSummarizer = new CodexExecTurnSummarizer({
    codexPath,
    processEnv: process.env,
  });
  const summarizer = createTurnSummaryProviderRouter({
    codex: codexSummarizer,
    info: (message) => log("provider", { message }),
  });
  const agentNames = await loadAgentNames();
  return new TurnSummaryPipeline({
    repository: new TurnSummaryRepository(sqlResolver, {
      resolveAgentName: ({ agentId }) => agentNames.get(agentId),
    }),
    configService,
    summarizer,
    // The live orchestrator owns the SSE fan-out; a maintenance process cannot
    // reach it, so backfilled summaries surface on the next read instead.
    eventHub: { publish: () => undefined },
    // No storyFolder: folding stays with the running orchestrator's sweep.
    logger: {
      warn: (...args: unknown[]) => log("pipeline_warning", { args }),
    },
  });
}

async function runBatch(
  pipeline: TurnSummaryPipeline,
  plans: SessionPlan[],
): Promise<void> {
  // The pipeline serialises jobs per session through its own tail chain, and
  // the Codex spawn limiter bounds real parallelism, so sessions are handed
  // over `concurrency` at a time to keep queued work proportional.
  for (let index = 0; index < plans.length; index += concurrency) {
    const slice = plans.slice(index, index + concurrency);
    for (const plan of slice) {
      pipeline.accept(plan.completeEventIds.map((completeEventId) =>
        completeEvent(plan.sessionId, completeEventId)
      ));
    }
    await pipeline.drain();
    log("progress", {
      sessionsDone: Math.min(index + concurrency, plans.length),
      sessionsInBatch: plans.length,
    });
  }
}

function completeEvent(
  sessionId: string,
  completeEventId: number,
): NodeRegistryEvent {
  return {
    type: "node_session_event",
    nodeId: "turn-summary-backfill",
    data: {
      type: "event",
      agentSessionId: sessionId,
      event: { type: "complete", _event_id: completeEventId },
    },
  } as unknown as NodeRegistryEvent;
}

async function countSummaries(
  sessionIds: string[],
): Promise<Map<string, number>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await sql<Array<{ session_id: string; n: number | string }>>`
    SELECT session_id, COUNT(*)::integer AS n
    FROM events
    WHERE event_type = 'turn_summary'
      AND session_id = ANY(${sessionIds}::text[])
    GROUP BY session_id
  `;
  return new Map(rows.map((row) => [row.session_id, Number(row.n)]));
}

async function loadAgentNames(): Promise<Map<string, string>> {
  const rows = await sql<Array<{ agent_id: string; name: string }>>`
    SELECT agent_id, name FROM agent_profiles
  `;
  return new Map(
    rows
      .filter((row) => typeof row.name === "string" && row.name.trim() !== "")
      .map((row) => [row.agent_id, row.name.trim()]),
  );
}

function loadState(): RunState {
  if (!existsSync(statePath)) {
    return { from, to, finishedSessionIds: [] };
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as RunState;
  if (parsed.from !== from || parsed.to !== to) {
    throw new Error(
      `state file ${statePath} was written for ${parsed.from}..${parsed.to}; ` +
        "pass --state with a fresh path or reuse the original window",
    );
  }
  return parsed;
}

function saveState(state: RunState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function log(event: string, fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

function readOption(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readIntOption(flag: string): number | undefined {
  const raw = readOption(flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

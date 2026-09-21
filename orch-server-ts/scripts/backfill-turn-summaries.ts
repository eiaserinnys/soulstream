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
 *   DATABASE_URL=... npx tsx scripts/backfill-turn-summaries.ts
 *   DATABASE_URL=... npx tsx scripts/backfill-turn-summaries.ts --apply --session <id>
 *   DATABASE_URL=... npx tsx scripts/backfill-turn-summaries.ts --apply --max-turns 60
 *
 * The run is foreground and bounded: it stops once `--max-turns` turns have
 * been handed to the pipeline, and records per-session progress in a state file
 * so the next invocation resumes. Re-running is always safe -- `hasSummary`
 * plus the dedupe key make every job idempotent, and an interrupted run simply
 * leaves its sessions pending.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { parse as parseYaml } from "yaml";

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
const DEFAULT_MAX_TURNS = 60;
const DEFAULT_CONCURRENCY = 1;
// A session that still has unwritten turns after this many invocations is
// reported instead of retried forever. Turns are legitimately skipped for
// agent-origin, excluded folders and non-summarizable sessions, so "fewer
// summaries than turns" is not by itself a failure.
const MAX_SESSION_ATTEMPTS = 2;

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
  attempts: Record<string, number>;
  unresolved: Array<{
    sessionId: string;
    turns: number;
    written: number;
    attempts: number;
  }>;
}

const apply = process.argv.includes("--apply");
const onlySession = readOption("--session");
const from = readOption("--from") ?? DEFAULT_FROM;
const to = readOption("--to") ?? DEFAULT_TO;
const maxTurns = readIntOption("--max-turns") ?? DEFAULT_MAX_TURNS;
const concurrency = readIntOption("--concurrency") ?? DEFAULT_CONCURRENCY;
const agentsPath = readOption("--agents");
const statePath = resolve(
  readOption("--state") ?? ".local/turn-summary-backfill-state.json",
);

const databaseUrl = requiredEnv("DATABASE_URL");
const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
const sqlResolver: LiveDbSqlResolver = {
  resolveSql: async () => sql as unknown as LivePostgresSql,
  close: async () => await sql.end({ timeout: 5 }),
};
// Sessions whose jobs raised inside the pipeline. The pipeline swallows job
// errors so `drain()` always resolves; without this the state file would mark a
// failed session finished and hide the failure forever.
const erroredSessionIds = new Set<string>();

// Turns are handed to the pipeline one at a time, so the last signal the
// pipeline logged unambiguously belongs to the turn just drained. This is how a
// stored summary is told apart from a by-design skip and from a real failure --
// an ineligible turn must never be counted as a success.
type TurnSignal =
  | { kind: "written" }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; detail: Record<string, unknown> };
let lastTurnSignal: TurnSignal | undefined;

interface SessionOutcome {
  written: number;
  alreadySummarized: number;
  ineligible: number;
  errors: number;
  skipReasons: Record<string, number>;
}

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
  if (baseConfig.provider !== "codex") {
    // The non-codex provider needs an API key this process does not load, and
    // the resulting failure is returned without a log line, which would look
    // like a successful zero-output run.
    throw new Error(
      `backfill supports the codex provider only; config says ${baseConfig.provider}`,
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

  const state = loadState();
  const plans = await buildInventory(new Set(state.finishedSessionIds));
  const eligible = plans.filter((plan) =>
    !state.finishedSessionIds.includes(plan.sessionId)
  );
  const batch = takeTurnBudget(eligible, maxTurns);

  log("inventory", {
    mode: apply ? "apply" : "dry-run",
    from,
    to,
    ...(onlySession === undefined ? {} : { session: onlySession }),
    model: baseConfig.model,
    provider: baseConfig.provider,
    concurrency,
    maxTurns,
    sessionsTotal: plans.length,
    turnsTotal: countTurns(plans),
    sessionsAlreadyFinished: plans.length - eligible.length,
    sessionsThisBatch: batch.length,
    turnsThisBatch: countTurns(batch),
    turnsRemainingAfterBatch: countTurns(eligible) - countTurns(batch),
  });

  if (!apply) {
    log("dry_run_complete", { note: "re-run with --apply to write summaries" });
  } else if (batch.length === 0) {
    log("nothing_to_do", { note: "every session in range is finished" });
  } else {
    const sessionIds = batch.map((plan) => plan.sessionId);
    // Watermark per session so newly written rows are counted, not pre-existing
    // ones and not summaries the live orchestrator writes during the run.
    const watermark = await maxSummaryEventId(sessionIds);
    const pipeline = await createPipeline(configService);
    const outcomes = await runBatch(pipeline, batch);
    // Independent oracle: the pipeline's own log lines say what it believed it
    // did, this re-read says what the database actually holds.
    const written = await countSummariesWritten(batch, watermark);

    const results = batch.map((plan) => {
      const turns = plan.completeEventIds.length;
      const outcome = outcomes.get(plan.sessionId);
      const rows = written.get(plan.sessionId) ?? 0;
      const attempts = (state.attempts[plan.sessionId] ?? 0) + 1;
      const accountedFor = (outcome?.written ?? 0) +
        (outcome?.alreadySummarized ?? 0) + (outcome?.ineligible ?? 0);
      return {
        sessionId: plan.sessionId,
        turns,
        written: rows,
        reportedWritten: outcome?.written ?? 0,
        alreadySummarized: outcome?.alreadySummarized ?? 0,
        ineligible: outcome?.ineligible ?? 0,
        errors: outcome?.errors ?? 0,
        skipReasons: outcome?.skipReasons ?? {},
        attempts,
        errored: erroredSessionIds.has(plan.sessionId) ||
          (outcome?.errors ?? 0) > 0,
        // "Complete" means every planned turn reached a terminal decision --
        // stored, already present, or excluded by design. Ineligible turns are
        // resolved, not successful, so they are not added to the written count.
        complete: accountedFor >= turns && (outcome?.errors ?? 0) === 0,
        // A disagreement between the pipeline's log and the database re-read is
        // itself a defect signal, so it is surfaced rather than reconciled.
        countMismatch: rows !== (outcome?.written ?? 0),
      };
    });

    const nextAttempts = { ...state.attempts };
    const finished: string[] = [];
    const unresolved: RunState["unresolved"] = [];
    for (const result of results) {
      nextAttempts[result.sessionId] = result.attempts;
      if (result.complete && !result.errored) {
        finished.push(result.sessionId);
        continue;
      }
      if (result.attempts >= MAX_SESSION_ATTEMPTS) {
        finished.push(result.sessionId);
        unresolved.push({
          sessionId: result.sessionId,
          turns: result.turns,
          written: result.written,
          attempts: result.attempts,
        });
      }
    }

    saveState({
      from,
      to,
      finishedSessionIds: [...state.finishedSessionIds, ...finished],
      attempts: nextAttempts,
      unresolved: [...state.unresolved, ...unresolved],
    });

    const sum = (pick: (row: (typeof results)[number]) => number): number =>
      results.reduce((total, row) => total + pick(row), 0);
    log("batch_complete", {
      sessions: batch.length,
      turns: countTurns(batch),
      summariesWrittenInDatabase: sum((row) => row.written),
      summariesReportedByPipeline: sum((row) => row.reportedWritten),
      turnsAlreadySummarized: sum((row) => row.alreadySummarized),
      // By-design exclusions (agent origin, excluded folder, non-summarizable
      // session, ...). Resolved, but not successes.
      turnsIneligible: sum((row) => row.ineligible),
      turnsErrored: sum((row) => row.errors),
      sessionsWithCountMismatch:
        results.filter((row) => row.countMismatch).map((row) => row.sessionId),
      skipReasons: mergeCounts(results.map((row) => row.skipReasons)),
      sessionsResolved: results.filter((row) => row.complete).length,
      retiredUnresolved: unresolved,
      sessionsRemaining: eligible.length - finished.length,
      turnsRemaining: countTurns(eligible) - countTurns(batch),
      statePath,
    });
  }
} finally {
  await sqlResolver.close();
}

async function buildInventory(
  alreadyFinished: ReadonlySet<string>,
): Promise<SessionPlan[]> {
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
    if (alreadyFinished.has(row.session_id)) continue;
    const list = bySession.get(row.session_id) ?? [];
    list.push(Number(row.id));
    bySession.set(row.session_id, list);
  }
  return [...bySession.entries()].map(([sessionId, completeEventIds]) => ({
    sessionId,
    // Ascending complete-event order keeps each session's recovered summaries
    // written in conversation order. Turn numbers are append labels, so a
    // session that already holds newer summaries is safe to backfill: the
    // recovered turns take the next free labels and nothing is renumbered.
    completeEventIds: completeEventIds.sort((a, b) => a - b),
  }));
}

function takeTurnBudget(plans: SessionPlan[], budget: number): SessionPlan[] {
  const batch: SessionPlan[] = [];
  let turns = 0;
  for (const plan of plans) {
    // Always admit the first session so a session larger than the budget still
    // makes progress instead of stalling the run forever.
    if (batch.length > 0 && turns + plan.completeEventIds.length > budget) break;
    batch.push(plan);
    turns += plan.completeEventIds.length;
    if (turns >= budget) break;
  }
  return batch;
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
  const agentNames = loadAgentNames();
  if (agentNames.size === 0) {
    log("agent_names_unavailable", {
      note:
        "delegated-turn speakers fall back to the raw agent id; pass --agents " +
        "<agents.yaml> to match the live orchestrator's labels",
    });
  }
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
      debug: (...args: unknown[]) => {
        const fields = describe(args);
        if (typeof fields.reason === "string") {
          lastTurnSignal = { kind: "skipped", reason: fields.reason };
        }
        log("pipeline_debug", fields);
      },
      info: (...args: unknown[]) => {
        const fields = describe(args);
        if (fields.message === "Turn summary stored") {
          lastTurnSignal = { kind: "written" };
        }
        log("pipeline_info", fields);
      },
      warn: (...args: unknown[]) => {
        const fields = describe(args);
        const sessionId = fields.sessionId;
        if (typeof sessionId === "string") erroredSessionIds.add(sessionId);
        lastTurnSignal = { kind: "error", detail: fields };
        log("pipeline_warning", fields);
      },
    },
  });
}

async function runBatch(
  pipeline: TurnSummaryPipeline,
  plans: SessionPlan[],
): Promise<Map<string, SessionOutcome>> {
  const outcomes = new Map<string, SessionOutcome>();
  let sessionsDone = 0;
  for (const plan of plans) {
    const outcome: SessionOutcome = {
      written: 0,
      alreadySummarized: 0,
      ineligible: 0,
      errors: 0,
      skipReasons: {},
    };
    outcomes.set(plan.sessionId, outcome);

    for (const completeEventId of plan.completeEventIds) {
      lastTurnSignal = undefined;
      pipeline.accept([completeEvent(plan.sessionId, completeEventId)]);
      await pipeline.drain();
      recordSignal(outcome, lastTurnSignal);
    }

    sessionsDone += 1;
    log("progress", {
      sessionsDone,
      sessionsInBatch: plans.length,
      sessionId: plan.sessionId,
      ...outcome,
    });
  }
  return outcomes;
}

function recordSignal(
  outcome: SessionOutcome,
  signal: TurnSignal | undefined,
): void {
  if (signal === undefined) {
    // No log line at all is the TurnSummaryProviderUnavailableError path, which
    // the pipeline returns on silently. Treat it as a failure, never a success.
    outcome.errors += 1;
    outcome.skipReasons.no_signal = (outcome.skipReasons.no_signal ?? 0) + 1;
    return;
  }
  if (signal.kind === "written") {
    outcome.written += 1;
    return;
  }
  if (signal.kind === "error") {
    outcome.errors += 1;
    return;
  }
  outcome.skipReasons[signal.reason] =
    (outcome.skipReasons[signal.reason] ?? 0) + 1;
  if (signal.reason === "already_summarized") {
    outcome.alreadySummarized += 1;
    return;
  }
  // agent_origin / excluded_folder / system_notification / internal_summary /
  // session_not_summarizable / delegated_* are by-design exclusions. They are
  // neither successes nor failures and must not be reported as either.
  outcome.ineligible += 1;
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

async function maxSummaryEventId(
  sessionIds: string[],
): Promise<Map<string, number>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await sql<Array<{ session_id: string; max_id: number | string }>>`
    SELECT session_id, MAX(id)::bigint AS max_id
    FROM events
    WHERE event_type = 'turn_summary'
      AND session_id = ANY(${sessionIds}::text[])
    GROUP BY session_id
  `;
  const watermark = new Map<string, number>(
    sessionIds.map((sessionId) => [sessionId, 0]),
  );
  for (const row of rows) watermark.set(row.session_id, Number(row.max_id));
  return watermark;
}

// Counts only rows this run is responsible for. A session can be resumed while
// the backfill is running -- observed in production on 2026-09-21, where the
// live orchestrator summarised a brand new turn in the same session seconds
// after the backfill wrote its own. Rows are therefore bounded twice: above the
// pre-run summary watermark (excludes rows that already existed) and at or
// below the last planned turn (excludes concurrent live turns, whose events sit
// past the end of the gap window).
async function countSummariesWritten(
  plans: SessionPlan[],
  watermark: Map<string, number>,
): Promise<Map<string, number>> {
  if (plans.length === 0) return new Map();
  const sessionIds = plans.map((plan) => plan.sessionId);
  const floors = plans.map((plan) => watermark.get(plan.sessionId) ?? 0);
  const ceilings = plans.map((plan) =>
    plan.completeEventIds[plan.completeEventIds.length - 1] ?? 0
  );
  const rows = await sql<Array<{ session_id: string; n: number | string }>>`
    SELECT e.session_id, COUNT(*)::integer AS n
    FROM events e
    JOIN (
      SELECT UNNEST(${sessionIds}::text[]) AS session_id,
             UNNEST(${floors}::bigint[]) AS floor_id,
             UNNEST(${ceilings}::bigint[]) AS ceiling_event_id
    ) w ON w.session_id = e.session_id
    WHERE e.event_type = 'turn_summary'
      AND e.id > w.floor_id
      AND COALESCE((e.payload->>'final_response_event_id')::bigint, e.id)
          <= w.ceiling_event_id
    GROUP BY e.session_id
  `;
  return new Map(rows.map((row) => [row.session_id, Number(row.n)]));
}


function loadAgentNames(): Map<string, string> {
  const names = new Map<string, string>();
  if (agentsPath === undefined || !existsSync(agentsPath)) return names;
  const parsed = parseYaml(readFileSync(agentsPath, "utf8")) as {
    agents?: Array<{
      id?: unknown;
      name?: unknown;
      aliases?: Array<{ id?: unknown }>;
    }>;
  };
  for (const agent of parsed.agents ?? []) {
    const name = typeof agent.name === "string" ? agent.name.trim() : "";
    if (name === "") continue;
    if (typeof agent.id === "string") names.set(agent.id, name);
    for (const alias of agent.aliases ?? []) {
      if (typeof alias.id === "string") names.set(alias.id, name);
    }
  }
  return names;
}

function mergeCounts(
  buckets: Array<Record<string, number>>,
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const bucket of buckets) {
    for (const [key, value] of Object.entries(bucket)) {
      merged[key] = (merged[key] ?? 0) + value;
    }
  }
  return merged;
}

function countTurns(plans: SessionPlan[]): number {
  return plans.reduce((sum, plan) => sum + plan.completeEventIds.length, 0);
}

function loadState(): RunState {
  if (!existsSync(statePath)) {
    return {
      from,
      to,
      finishedSessionIds: [],
      attempts: {},
      unresolved: [],
    };
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as RunState;
  if (parsed.from !== from || parsed.to !== to) {
    throw new Error(
      `state file ${statePath} was written for ${parsed.from}..${parsed.to}; ` +
        "pass --state with a fresh path or reuse the original window",
    );
  }
  return {
    ...parsed,
    attempts: parsed.attempts ?? {},
    unresolved: parsed.unresolved ?? [],
  };
}

function saveState(state: RunState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

// pino-style loggers are called as (fields, message). Errors are carried on
// `err` and their message/stack are non-enumerable, so JSON.stringify would
// render them as `{}`.
function describe(args: unknown[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const arg of args) {
    if (typeof arg === "string") {
      fields.message = arg;
      continue;
    }
    if (arg === null || typeof arg !== "object") continue;
    for (const [key, value] of Object.entries(arg)) {
      fields[key] = value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value;
    }
  }
  return fields;
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

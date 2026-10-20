import { SessionStatisticsDailyRepository } from "./session_statistics_daily_repository.js";
import type { UsageStatsOverview } from "@soulstream/wire-schema/session-statistics";
import type { BoardYjsQuerySql, BoardYjsSql } from "../board-yjs/board_yjs_sql.js";
import { SESSION_STATISTICS_PROJECTION_SETTING_KEY } from "./session_statistics_backfill.js";
import {
  createCanonicalSessionStatisticsFacts,
  type CanonicalSessionStatisticsRow,
} from "./session_statistics_canonical_sql.js";
import {
  resolveSessionStatisticsDateSlice,
  resolveSessionStatisticsDay,
  resolveSessionStatisticsPeriod,
  parseOffsetTimestamp,
} from "./session_statistics_period.js";
import type {
  SessionStatisticsReadRequest,
  SessionStatisticsReadResult,
  SessionStatisticsRepositoryPort,
  SessionStatisticsScopeSession,
} from "./session_statistics_types.js";

type SessionSqlRow = {
  session_id: string;
  folder_id: string | null;
  card_id: string | null;
  card_folder_id: string | null;
};

type ProjectionSqlRow = {
  value: unknown;
  version: number | string;
};

type EarliestSqlRow = {
  earliest_created_at: string | Date | null;
};

type CostSqlRow = {
  session_id: string;
  event_id: number | string;
  part_key: string;
  known_cost_usd: string;
};

type ProjectionState = {
  state: "ready" | "backfilling" | "rebuilding";
  normalization_version: 1;
  covered_since: string | null;
};

type CostSource = {
  session_id: string;
  event_id: string;
  part_key: string;
};

export class SessionStatisticsRepository implements SessionStatisticsRepositoryPort {
  readonly daily: SessionStatisticsDailyRepository;
  constructor(private readonly sql: BoardYjsSql) {
    this.daily = new SessionStatisticsDailyRepository(sql);
  }

  readMetadata(input: SessionStatisticsReadRequest): Promise<SessionStatisticsReadResult> {
    return this.readInternal(input, "metadata");
  }

  readSlice(input: SessionStatisticsReadRequest, day: string): Promise<SessionStatisticsReadResult> {
    return this.readInternal(input, "slice", day);
  }

  async read(input: SessionStatisticsReadRequest): Promise<SessionStatisticsReadResult> {
    return this.readInternal(input, "direct");
  }

  private async readInternal(input: SessionStatisticsReadRequest, mode: "direct" | "metadata" | "slice", sliceDay?: string): Promise<SessionStatisticsReadResult> {
    parseOffsetTimestamp(input.asOf, "asOf");
    return await this.sql.begin(async (transaction) => {
      await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
      await transaction`SET LOCAL jit = off`;
      await transaction`SET LOCAL client_min_messages = warning`;
      const sessions = await readAuthorizedSessions(transaction, input);
      const projectionState = await readProjectionState(transaction);
      const sessionIds = sessions.map((session) => session.sessionId);
      const authorizedEarliest = await readAuthorizedEarliest(
        transaction,
        input,
      );
      let period = resolveSessionStatisticsPeriod(
        input.query,
        input.asOf,
        authorizedEarliest,
      );
      if (mode === "slice") {
        const bounds = resolveSessionStatisticsDateSlice(sliceDay!, input.asOf);
        const next = new Date(`${sliceDay}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        period = { ...period, ...bounds,
          range: { ...period.range, since: sliceDay!, until: next.toISOString().slice(0, 10),
            effective_until: next.toISOString().slice(0, 10), bucket: "day" },
          empty: Date.parse(bounds.recordedAtFrom) >= Date.parse(bounds.recordedAtBefore),
        };
      }
      const projectionStatus = buildProjectionStatus(
        projectionState,
        authorizedEarliest,
      );

      let rows: readonly CanonicalSessionStatisticsRow[] = [];
      let costDecimals: ReadonlyMap<string, string> = new Map();
      let readPurpose: {
        kind: "overview";
      } | {
        kind: "day";
        recordedAtFrom: string;
        recordedAtBefore: string;
      };
      if (mode === "slice") {
        readPurpose = { kind: "day", recordedAtFrom: period.recordedAtFrom, recordedAtBefore: period.recordedAtBefore };
      } else if (input.day === null || mode === "metadata") {
        readPurpose = { kind: "overview" };
      } else {
        const day = resolveSessionStatisticsDay(input.day, period.range, input.asOf);
        readPurpose = { kind: "day", ...day };
      }

      const isEmptyDay = readPurpose.kind === "day"
        && Date.parse(readPurpose.recordedAtFrom) >= Date.parse(readPurpose.recordedAtBefore);
      if (mode !== "metadata" && sessionIds.length > 0 && !period.empty && !isEmptyDay) {
        rows = await createCanonicalSessionStatisticsFacts(
          transaction,
          sessionIds,
          {
            recordedAtFrom: period.recordedAtFrom,
            recordedAtBefore: period.recordedAtBefore,
          },
          { asOf: input.asOf, readPurpose },
        );
        costDecimals = await readSelectedCostDecimals(
          transaction,
          sessionIds,
          input.asOf,
          rows,
        );
      }

      return {
        query: input.query,
        asOf: input.asOf,
        range: period.range,
        projectionStatus,
        collectionCoverage: "unknown",
        sessions,
        rows,
        costDecimals,
      };
    });
  }
}

async function readAuthorizedSessions(
  sql: BoardYjsQuerySql,
  input: SessionStatisticsReadRequest,
): Promise<SessionStatisticsScopeSession[]> {
  const visibleFolderIds = [...new Set(input.visibleFolders.map((folder) => folder.id))];
  const rows = await sql<readonly SessionSqlRow[]>`
    WITH authorized_sessions AS (
      SELECT session_id, folder_id, card_id
      FROM sessions
      WHERE (NOT ${input.access.restricted}
        OR folder_id = ANY(${sql.array(visibleFolderIds)}::text[]))
    )
    SELECT s.session_id, s.folder_id, s.card_id,
      card.folder_id AS card_folder_id
    FROM authorized_sessions AS s
    LEFT JOIN cards AS card ON card.id = s.card_id
    ORDER BY s.session_id
  `;
  const visibleFolderById = new Map(input.visibleFolders.map((folder) => [folder.id, folder]));
  return rows.map((row) => {
    const sessionFolderId = row.folder_id;
    const sourceFolderId = sessionFolderId ?? row.card_folder_id;
    const project = sourceFolderId === null
      ? null
      : visibleProject(sourceFolderId, visibleFolderById);
    return {
      sessionId: row.session_id,
      folderId: sessionFolderId,
      cardFolderId: row.card_folder_id,
      projectId: project?.id ?? null,
      projectLabel: project?.label ?? "미분류",
    };
  });
}

function visibleProject(
  sourceFolderId: string,
  visibleFolderById: ReadonlyMap<string, SessionStatisticsReadRequest["visibleFolders"][number]>,
): { id: string; label: string } | null {
  let current = visibleFolderById.get(sourceFolderId);
  if (current === undefined) return null;
  while (typeof current.parentFolderId === "string") {
    const parent = visibleFolderById.get(current.parentFolderId);
    if (parent === undefined) break;
    current = parent;
  }
  const label = current.name;
  if (typeof label !== "string") {
    throw new Error("session statistics visible project name is invalid");
  }
  return { id: current.id, label };
}

async function readProjectionState(sql: BoardYjsQuerySql): Promise<ProjectionState> {
  const rows = await sql<readonly ProjectionSqlRow[]>`
    SELECT value, version
    FROM system_settings
    WHERE setting_key = ${SESSION_STATISTICS_PROJECTION_SETTING_KEY}
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("session statistics projection checkpoint is missing");
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("session statistics projection checkpoint version is invalid");
  }
  const value = typeof row.value === "string" ? parseJson(row.value) : row.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("session statistics projection checkpoint is invalid");
  }
  const state = value as Record<string, unknown>;
  if (state.normalization_version !== 1) {
    throw new Error("session statistics projection normalization version is unsupported");
  }
  if (state.state !== "ready" && state.state !== "backfilling" && state.state !== "rebuilding") {
    throw new Error("session statistics projection checkpoint state is invalid");
  }
  if (state.covered_since !== null && typeof state.covered_since !== "string") {
    throw new Error("session statistics projection covered_since is invalid");
  }
  if (state.covered_since === null || state.covered_since === undefined) {
    throw new Error("session statistics projection checkpoint is not initialized");
  }
  parseOffsetTimestamp(state.covered_since, "projection covered_since");
  return {
    state: state.state,
    normalization_version: 1,
    covered_since: state.covered_since,
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("session statistics projection checkpoint is invalid");
  }
}

async function readAuthorizedEarliest(
  sql: BoardYjsQuerySql,
  input: SessionStatisticsReadRequest,
): Promise<string | null> {
  const visibleFolderIds = [...new Set(input.visibleFolders.map((folder) => folder.id))];
  const rows = await sql<readonly EarliestSqlRow[]>`
    SELECT min(created_at) AS earliest_created_at
    FROM sessions
    WHERE (NOT ${input.access.restricted}
      OR folder_id = ANY(${sql.array(visibleFolderIds)}::text[]))
      AND created_at < ${input.asOf}::timestamptz
  `;
  const value = rows[0]?.earliest_created_at ?? null;
  if (value === null) return null;
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("session statistics authorized event timestamp is invalid");
  }
  return timestamp.toISOString();
}

function buildProjectionStatus(
  projection: ProjectionState,
  authorizedEarliest: string | null,
): UsageStatsOverview["projection_status"] {
  const covered = parseOffsetTimestamp(projection.covered_since as string, "projection covered_since");
  const earliest = authorizedEarliest === null
    ? null
    : parseOffsetTimestamp(authorizedEarliest, "authorizedEarliest");
  const effective = earliest !== null && earliest.getTime() > covered.getTime() ? earliest : covered;
  return {
    state: projection.state === "rebuilding" ? "backfilling" : projection.state,
    covered_since: kstDate(effective),
  };
}

async function readSelectedCostDecimals(
  sql: BoardYjsQuerySql,
  authorizedSessionIds: readonly string[],
  asOf: string,
  rows: readonly CanonicalSessionStatisticsRow[],
): Promise<ReadonlyMap<string, string>> {
  const selected = new Map<string, CostSource>();
  for (const row of rows) {
    const fact = row.fact;
    if (row.row_kind !== "usage" || row.state !== "owned" || fact === null
      || fact.known_cost_usd === null) continue;
    selected.set(costSourceKey(row.session_id, fact.event_id, fact.part_key), {
      session_id: row.session_id,
      event_id: String(fact.event_id),
      part_key: fact.part_key,
    });
  }
  const sources = [...selected.values()];
  if (sources.length === 0) return new Map();
  const decimalRows = await sql<readonly CostSqlRow[]>`
    WITH authorized_sessions AS (
      SELECT value AS session_id
      FROM jsonb_array_elements_text(${sql.json([...new Set(authorizedSessionIds)])}::jsonb)
    ),
    selected_sources AS (
      SELECT source.session_id, source.event_id, source.part_key
      FROM jsonb_to_recordset(${sql.json(sources)}::jsonb)
        AS source(session_id TEXT, event_id BIGINT, part_key TEXT)
    )
    SELECT fact.session_id, fact.event_id, fact.part_key, fact.known_cost_usd::text AS known_cost_usd
    FROM session_statistics_facts AS fact
    JOIN authorized_sessions AS allowed USING (session_id)
    JOIN selected_sources AS selected USING (session_id, event_id, part_key)
    WHERE fact.fact_kind = 'usage'
      AND fact.recorded_at < ${asOf}::timestamptz
      AND fact.known_cost_usd IS NOT NULL
  `;
  const costDecimals = new Map<string, string>();
  for (const row of decimalRows) {
    costDecimals.set(costSourceKey(row.session_id, row.event_id, row.part_key), row.known_cost_usd);
  }
  if (costDecimals.size !== selected.size) {
    throw new Error("session statistics selected cost source is missing");
  }
  return costDecimals;
}

function costSourceKey(sessionId: string, eventId: number | string, partKey: string): string {
  return JSON.stringify([sessionId, String(eventId), partKey]);
}

function kstDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("session statistics KST date could not be resolved");
  }
  return `${year}-${month}-${day}`;
}

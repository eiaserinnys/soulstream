/**
 * 이벤트 전달 지연 조회 (카드 #1595).
 *
 * 지연 = orch가 사건을 커밋한 시각(event_ingress_receipts.created_at) - 노드가
 * 사건을 만든 시각(events.created_at). 두 표를 (session_id, event_id)로 잇는다.
 * 노드 시계 차이로 음수가 나와도 그대로 낸다.
 *
 * 새 DB 풀을 만들지 않고 orch가 이미 가진 SQL 클라이언트를 받는다. 한 트랜잭션
 * 안에서 statement_timeout을 55초로 걸어 느린 조회가 풀을 오래 붙잡지 않게 한다.
 */

export type DeliveryLatencyQuery = <
  T extends readonly Record<string, unknown>[] = readonly Record<string, unknown>[],
>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

export type DeliveryLatencySql = DeliveryLatencyQuery & {
  begin<T>(callback: (sql: DeliveryLatencyQuery) => Promise<T>): Promise<T>;
};

export type DeliveryLatencyQueryInput = {
  since?: string;
  until?: string;
  node_id?: string;
};

export type DeliveryLatencyStats = {
  count: number;
  p50_ms: number | null;
  p90_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;
};

export type DeliveryLatencyNodeStats = DeliveryLatencyStats & { node_id: string };

export type DeliveryLatencySlowestEvent = {
  node_id: string;
  session_id: string;
  event_id: number;
  event_type: string;
  created_at: string;
  committed_at: string;
  delay_ms: number;
};

export type DeliveryLatencyResult = {
  window: { since: string; until: string };
  overall: DeliveryLatencyStats;
  by_node: DeliveryLatencyNodeStats[];
  slowest: DeliveryLatencySlowestEvent[];
};

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const STATEMENT_TIMEOUT = "55000ms";

export async function queryEventIngressDeliveryLatency(
  sql: DeliveryLatencySql,
  input: DeliveryLatencyQueryInput,
  now: () => Date = () => new Date(),
): Promise<DeliveryLatencyResult> {
  const until =
    input.until === undefined ? now() : parseTimestamp(input.until, "until");
  const since =
    input.since === undefined
      ? new Date(until.getTime() - DEFAULT_WINDOW_MS)
      : parseTimestamp(input.since, "since");
  if (since.getTime() >= until.getTime()) {
    throw new Error("since must be earlier than until");
  }
  if (until.getTime() - since.getTime() > MAX_WINDOW_MS) {
    throw new Error("delivery latency window must be 7 days or shorter");
  }

  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();
  const nodeId = input.node_id ?? null;

  const rows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true),
                    set_config('enable_hashjoin', 'off', true)`;
    return await tx`
      WITH joined AS MATERIALIZED (
        SELECT r.node_id, r.session_id, r.event_id, r.created_at - e.created_at AS delay,
               EXTRACT(EPOCH FROM (r.created_at - e.created_at)) * 1000 AS delay_ms
        FROM event_ingress_receipts r
        JOIN events e ON e.session_id = r.session_id AND e.id = r.event_id
        WHERE r.created_at >= ${sinceIso} AND r.created_at < ${untilIso}
          AND (${nodeId}::text IS NULL OR r.node_id = ${nodeId})
      ), aggregated AS (
        SELECT CASE WHEN GROUPING(node_id) = 1 THEN 'overall' ELSE 'node' END AS kind,
               node_id, count(*)::int AS count,
               percentile_cont(ARRAY[0.5, 0.9, 0.99]) WITHIN GROUP (ORDER BY delay_ms) AS percentiles,
               max(delay_ms)::double precision AS max_ms
        FROM joined
        GROUP BY GROUPING SETS ((node_id), ())
      ), results AS (
        SELECT kind, node_id, count, percentiles[1] AS p50_ms,
               percentiles[2] AS p90_ms, percentiles[3] AS p99_ms, max_ms,
               NULL::text AS session_id, NULL::integer AS event_id,
               NULL::text AS event_type, NULL::timestamptz AS event_created_at,
               NULL::timestamptz AS committed_at, NULL::double precision AS delay_ms,
               NULL::interval AS delay
        FROM aggregated
        UNION ALL
        SELECT 'slowest', slowest.node_id, NULL::int, NULL::double precision,
               NULL::double precision, NULL::double precision, NULL::double precision,
               slowest.session_id, slowest.event_id, e.event_type, e.created_at,
               -- Add the elapsed interval in UTC so daylight-saving changes cannot shift it.
               ((e.created_at AT TIME ZONE 'UTC') + slowest.delay) AT TIME ZONE 'UTC',
               slowest.delay_ms::double precision, slowest.delay
        FROM (
          SELECT * FROM joined ORDER BY delay DESC, event_id DESC LIMIT 5
        ) slowest
        JOIN events e ON e.session_id = slowest.session_id AND e.id = slowest.event_id
      )
      SELECT * FROM results
      ORDER BY kind, CASE WHEN kind = 'node' THEN node_id END, delay DESC, event_id DESC
    `;
  });
  const nodeRows = rows.filter((row) => row.kind === "node");
  const overallRow = rows.find((row) => row.kind === "overall");
  const slowestRows = rows.filter((row) => row.kind === "slowest");

  return {
    window: { since: sinceIso, until: untilIso },
    overall: stats(overallRow),
    by_node: nodeRows.map((row) => ({
      node_id: String(row.node_id),
      ...stats(row),
    })),
    slowest: slowestRows.map((row) => ({
      node_id: String(row.node_id),
      session_id: String(row.session_id),
      event_id: Number(row.event_id),
      event_type: String(row.event_type),
      created_at: isoTimestamp(row.event_created_at),
      committed_at: isoTimestamp(row.committed_at),
      delay_ms: Number(row.delay_ms),
    })),
  };
}

function parseTimestamp(value: string, field: string): Date {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be an ISO-8601 timestamp`);
  }
  return new Date(parsed);
}

function stats(row: Record<string, unknown> | undefined): DeliveryLatencyStats {
  return {
    count: Number(row?.count ?? 0),
    p50_ms: numberOrNull(row?.p50_ms),
    p90_ms: numberOrNull(row?.p90_ms),
    p99_ms: numberOrNull(row?.p99_ms),
    max_ms: numberOrNull(row?.max_ms),
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

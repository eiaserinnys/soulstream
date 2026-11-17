import { describe, expect, it } from "vitest";

import {
  queryEventIngressDeliveryLatency,
  type DeliveryLatencyQuery,
  type DeliveryLatencySql,
} from "../src/node/event_ingress_delivery_latency.js";

const NOW = new Date("2026-11-17T12:00:00.000Z");

type RecordedQuery = { text: string; values: unknown[] };

function fakeSql(rows: {
  byNode?: readonly Record<string, unknown>[];
  overall?: readonly Record<string, unknown>[];
  slowest?: readonly Record<string, unknown>[];
}): { sql: DeliveryLatencySql; calls: RecordedQuery[] } {
  const calls: RecordedQuery[] = [];
  let sql!: DeliveryLatencySql;
  const query = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ").replace(/\s+/g, " ");
    calls.push({ text, values });
    if (text.includes("set_config")) return [];
    if (text.includes("GROUP BY")) return rows.byNode ?? [];
    if (text.includes("LIMIT 5")) return rows.slowest ?? [];
    return rows.overall ?? [];
  }) as DeliveryLatencyQuery;
  sql = Object.assign(query, {
    begin: async <T>(callback: (tx: DeliveryLatencyQuery) => Promise<T>): Promise<T> => callback(query),
  }) as DeliveryLatencySql;
  return { sql, calls };
}

const BY_NODE = [
  { node_id: "node-a", count: 2, p50_ms: 12.5, p90_ms: 20, p99_ms: 25, max_ms: 30 },
  { node_id: "node-b", count: 1, p50_ms: 7, p90_ms: 7, p99_ms: 7, max_ms: 7 },
];
const OVERALL = [{ count: 3, p50_ms: 11, p90_ms: 19, p99_ms: 24, max_ms: 30 }];
const SLOWEST = [
  {
    node_id: "node-b",
    session_id: "session-b",
    event_id: 42,
    event_type: "assistant_message",
    event_created_at: new Date("2026-11-17T11:59:00.000Z"),
    committed_at: new Date("2026-11-17T11:59:30.000Z"),
    delay_ms: 30_000,
  },
];

describe("get_event_ingress_delivery_latency query", () => {
  it("defaults the window to the last hour and shapes the response", async () => {
    const { sql } = fakeSql({ byNode: BY_NODE, overall: OVERALL, slowest: SLOWEST });

    const result = await queryEventIngressDeliveryLatency(sql, {}, () => NOW);

    expect(result).toEqual({
      window: { since: "2026-11-17T11:00:00.000Z", until: "2026-11-17T12:00:00.000Z" },
      overall: { count: 3, p50_ms: 11, p90_ms: 19, p99_ms: 24, max_ms: 30 },
      by_node: [
        { node_id: "node-a", count: 2, p50_ms: 12.5, p90_ms: 20, p99_ms: 25, max_ms: 30 },
        { node_id: "node-b", count: 1, p50_ms: 7, p90_ms: 7, p99_ms: 7, max_ms: 7 },
      ],
      slowest: [
        {
          node_id: "node-b",
          session_id: "session-b",
          event_id: 42,
          event_type: "assistant_message",
          created_at: "2026-11-17T11:59:00.000Z",
          committed_at: "2026-11-17T11:59:30.000Z",
          delay_ms: 30_000,
        },
      ],
    });
  });

  it("sets a transaction-local statement_timeout and joins receipts to events", async () => {
    const { sql, calls } = fakeSql({ byNode: BY_NODE, overall: OVERALL });

    await queryEventIngressDeliveryLatency(
      sql,
      { since: "2026-11-17T10:00:00.000Z", until: "2026-11-17T12:00:00.000Z", node_id: "node-a" },
      () => NOW,
    );

    expect(calls[0]?.text).toContain("set_config('statement_timeout'");
    expect(calls[0]?.values).toContain("10000ms");
    for (const call of calls.slice(1)) {
      expect(call.text).toContain("event_ingress_receipts r");
      expect(call.text).toContain("JOIN events e ON e.session_id = r.session_id AND e.id = r.event_id");
      expect(call.text).toContain("r.created_at >=");
      expect(call.values).toContain("node-a");
    }
  });

  it("rejects a window longer than 7 days, an empty window, and unparseable bounds", async () => {
    const { sql } = fakeSql({});

    await expect(queryEventIngressDeliveryLatency(sql, {
      since: "2026-11-01T00:00:00.000Z",
      until: "2026-11-08T00:00:00.001Z",
    }, () => NOW)).rejects.toThrow(/7 days/);
    await expect(queryEventIngressDeliveryLatency(sql, {
      since: "2026-11-17T00:00:00.000Z",
      until: "2026-11-17T00:00:00.000Z",
    }, () => NOW)).rejects.toThrow(/earlier/);
    await expect(queryEventIngressDeliveryLatency(sql, {
      since: "yesterday",
    }, () => NOW)).rejects.toThrow(/since/);
  });

  it("accepts exactly seven days and returns null stats for an empty window", async () => {
    const { sql } = fakeSql({});

    const result = await queryEventIngressDeliveryLatency(sql, {
      since: "2026-11-01T00:00:00.000Z",
      until: "2026-11-08T00:00:00.000Z",
    }, () => NOW);

    expect(result.overall).toEqual({ count: 0, p50_ms: null, p90_ms: null, p99_ms: null, max_ms: null });
    expect(result.by_node).toEqual([]);
    expect(result.slowest).toEqual([]);
  });
});

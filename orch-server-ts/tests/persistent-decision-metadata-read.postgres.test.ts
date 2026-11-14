import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { EventReadRepository } from "../src/control_plane/repositories/event_read_repository.js";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";

const hasPostgres = Boolean(process.env.TEST_DATABASE_URL?.trim()) ||
  spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const describePostgres = hasPostgres ? describe : describe.skip;

describePostgres("persistent decision metadata reads in PostgreSQL", () => {
  let harness: FullSchemaPostgresHarness;
  let events: EventReadRepository;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    events = new EventReadRepository(harness.sql as unknown as SqlClient);
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("keeps only the requested metadata type with id order, afterId, and limit", async () => {
    const sessionId = `decision-metadata-${randomUUID()}`;
    await harness.sql`INSERT INTO sessions (session_id, display_name) VALUES (${sessionId}, ${sessionId})`;
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload, searchable_text)
      SELECT
        ${sessionId},
        g,
        'metadata',
        jsonb_build_object('metadata_type', 'session_settings', 'value', repeat('x', 400)),
        ''
      FROM generate_series(1, 10000) AS g
    `;
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload, searchable_text)
      SELECT
        ${sessionId},
        10000 + g,
        'metadata',
        jsonb_build_object(
          'metadata_type', 'persistent_generation',
          'value', jsonb_build_object(
            'number', g,
            'first_call', jsonb_build_object(
              'generation', g,
              'model_preset', 'claude-opus',
              'input_tokens', g * 1000
            )
          )
        ),
        ''
      FROM generate_series(1, 40) AS g
    `;

    const startedAt = Date.now();
    const filtered = await events.readEvents(
      sessionId,
      0,
      20000,
      undefined,
      undefined,
      ["persistent_generation"],
    );
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2000);
    expect(filtered.map((row) => row.id))
      .toEqual(Array.from({ length: 40 }, (_, index) => 10001 + index));
    expect(filtered.every((row) => row.payload.metadata_type === "persistent_generation"))
      .toBe(true);

    const windowed = await events.readEvents(
      sessionId,
      10020,
      5,
      ["metadata"],
      undefined,
      ["persistent_generation"],
    );
    expect(windowed.map((row) => row.id)).toEqual([10021, 10022, 10023, 10024, 10025]);

    const unfiltered = await events.readEvents(sessionId, 0, 20000);
    expect(unfiltered).toHaveLength(10040);
  }, 60_000);

  it("returns the newest metadata generation rows first only when order is desc", async () => {
    const sessionId = `decision-metadata-desc-${randomUUID()}`;
    await harness.sql`INSERT INTO sessions (session_id, display_name) VALUES (${sessionId}, ${sessionId})`;
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload, searchable_text)
      SELECT
        ${sessionId},
        g,
        'metadata',
        jsonb_build_object('metadata_type', 'session_settings', 'value', repeat('x', 400)),
        ''
      FROM generate_series(1, 10000) AS g
    `;
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload, searchable_text)
      SELECT
        ${sessionId},
        10000 + g,
        'metadata',
        jsonb_build_object(
          'metadata_type', 'persistent_generation',
          'value', jsonb_build_object(
            'number', g,
            'first_call', jsonb_build_object(
              'generation', g,
              'model_preset', 'claude-opus',
              'input_tokens', g * 1000
            )
          )
        ),
        ''
      FROM generate_series(1, 40) AS g
    `;
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload, searchable_text)
      SELECT
        ${sessionId},
        10040 + g,
        'assistant_message',
        jsonb_build_object('metadata_type', 'persistent_generation', 'value', jsonb_build_object('number', g)),
        ''
      FROM generate_series(1, 5) AS g
    `;

    const newest = await events.readEvents(
      sessionId,
      0,
      5,
      ["metadata"],
      undefined,
      ["persistent_generation"],
      "desc",
    );
    expect(newest.map((row) => row.id)).toEqual([10040, 10039, 10038, 10037, 10036]);
    expect(newest.every((row) => row.event_type === "metadata")).toBe(true);

    const ascending = await events.readEvents(
      sessionId,
      0,
      5,
      ["metadata"],
      undefined,
      ["persistent_generation"],
    );
    expect(ascending.map((row) => row.id)).toEqual([10001, 10002, 10003, 10004, 10005]);
  }, 60_000);

  it("scans the session/type index backward and stops after the newest 50 generation rows", async () => {
    const sessionId = `decision-metadata-window-${randomUUID()}`;
    await harness.sql`INSERT INTO sessions (session_id, display_name) VALUES (${sessionId}, ${sessionId})`;
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload, searchable_text)
      SELECT
        ${sessionId},
        g,
        'metadata',
        jsonb_build_object('metadata_type', 'session_settings', 'value', repeat('x', 400)),
        ''
      FROM generate_series(1, 2000) AS g
    `;
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload, searchable_text)
      SELECT
        ${sessionId},
        2000 + g,
        'metadata',
        jsonb_build_object(
          'metadata_type', 'persistent_generation',
          'value', jsonb_build_object(
            'number', g,
            'first_call', jsonb_build_object(
              'generation', g,
              'model_preset', 'claude-opus',
              'input_tokens', g * 1000
            )
          )
        ),
        ''
      FROM generate_series(1, 60) AS g
    `;
    // 운영 세션처럼 metadata가 아닌 이벤트가 더 많아야 events_pkey 역방향 전수 스캔이
    // 같은 비용의 대안이 되지 않고, event_type을 색인 조건으로 쓰는
    // idx_events_session_type_id 역방향 스캔이 선택된다.
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload, searchable_text)
      SELECT
        ${sessionId},
        2060 + g,
        'assistant_message',
        jsonb_build_object('text', repeat('y', 200)),
        ''
      FROM generate_series(1, 10000) AS g
    `;
    await harness.sql`ANALYZE events`;

    // 저장소가 만든 바로 그 SQL을 잡아 EXPLAIN에 그대로 쓴다.
    const executed: Array<{ text: string; values: readonly unknown[] }> = [];
    const capturingSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      executed.push({ text: strings.join("?"), values });
      return (harness.sql as unknown as (
        template: TemplateStringsArray,
        ...args: readonly unknown[]
      ) => Promise<unknown>)(strings, ...values);
    }) as unknown as SqlClient;
    const repository = new EventReadRepository(capturingSql);

    const rows = await repository.readEvents(
      sessionId,
      0,
      50,
      ["metadata"],
      undefined,
      ["persistent_generation"],
      "desc",
    );
    expect(rows.map((row) => row.id))
      .toEqual(Array.from({ length: 50 }, (_, index) => 2060 - index));

    const query = executed[executed.length - 1]!;
    let parameter = 0;
    const explainTarget = query.text.replace(/\?/g, () => `$${(parameter += 1)}`);
    const explained = await harness.sql.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${explainTarget}`,
      query.values as never[],
    ) as unknown as Array<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>;
    const plan = explained[0]!["QUERY PLAN"][0]!.Plan;
    const nodes: Array<Record<string, unknown>> = [];
    const collect = (node: Record<string, unknown>) => {
      nodes.push(node);
      for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) {
        collect(child);
      }
    };
    collect(plan);

    const indexScan = nodes.find((node) => node["Node Type"] === "Index Scan");
    expect(indexScan).toMatchObject({
      "Scan Direction": "Backward",
      "Index Name": "idx_events_session_type_id",
    });
    expect(nodes.filter((node) => node["Node Type"] === "Bitmap Heap Scan")).toEqual([]);
    expect(nodes.filter((node) => node["Node Type"] === "Sort")).toEqual([]);
    expect(indexScan?.["Rows Removed by Filter"] ?? 0).toBe(0);
    expect(indexScan?.["Actual Rows"]).toBe(50);
  }, 60_000);
});

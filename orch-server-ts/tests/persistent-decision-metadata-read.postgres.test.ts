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
});

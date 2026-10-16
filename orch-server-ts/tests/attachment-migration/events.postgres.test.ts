import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractSessionAttachmentSources } from "../../scripts/attachment-migration/extract_events.js";
import { EVENTS_EXPORTED, type EventExtractionProgress } from "../../scripts/attachment-migration/inventory_contract.js";
import { startPostgresTestContainer } from "../../../packages/db-schema/scripts/postgres-test-container.mjs";
import { waitForPostgres } from "../persistent-session-settings-world.js";

const CUTOFF = "2026-10-17T00:00:00.000Z";
const AFTER = "2026-10-17T00:00:00.001Z";

describe("read-only event attachment inventory against PostgreSQL", () => {
  let sql: ReturnType<typeof postgres>;
  let stop: (() => void) | undefined;

  beforeAll(async () => {
    const container = startPostgresTestContainer({ user: "event_inventory_test", password: "event_inventory_test", database: "event_inventory_test_db" });
    stop = container.stop;
    const url = `postgres://event_inventory_test:event_inventory_test@127.0.0.1:${container.port}/event_inventory_test_db`;
    const bootstrap = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      await waitForPostgres(bootstrap);
      const schema = await readFile(new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8");
      await bootstrap.unsafe(schema);
    } finally {
      await bootstrap.end({ timeout: 2 });
    }
    sql = postgres(url, { max: 2, onnotice: () => undefined });
    expect(Number((await sql`SELECT COUNT(*) AS n FROM events`)[0]!.n)).toBe(0);
    await sql`INSERT INTO sessions(session_id,node_id,status) VALUES ('event-source','historical-node','archived')`;
  }, 90_000);

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    stop?.();
  });

  it("includes created_at equal to cutoff, excludes later rows, advances over non-source events, and detects missing sessions", async () => {
    await sql`INSERT INTO events(session_id,id,event_type,payload,created_at)
      VALUES ('event-source',1,'heartbeat','{}'::jsonb,${new Date(CUTOFF)}),
             ('event-source',2,'user_message',${sql.json({ attachments: ["/incoming/equal.png"], attachment_ids: ["asset-input"] })}::jsonb,${new Date(CUTOFF)}),
             ('event-source',3,'complete',${sql.json({ attachments: ["/incoming/later.png"] })}::jsonb,${new Date(AFTER)})`;
    const progress: EventExtractionProgress[] = [];
    const sources = await collect(extractSessionAttachmentSources(sql as never, ["deleted-session", "event-source"], {
      pageSize: 1,
      cutoff: CUTOFF,
      onProgress: (value) => { progress.push(value); },
    }));

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ source_pk: "2", session_id: "event-source", data: { source_node_id: "historical-node" } });
    expect(sources[0]!.created_at).toBe(CUTOFF);
    expect(progress).toContainEqual(expect.objectContaining({ session_id: "deleted-session", state: "source_changed", error_code: "INVENTORY_SOURCE_CHANGED", coverage_complete: false }));
    expect(progress.at(-1)).toMatchObject({ session_id: "event-source", state: "complete", cursor: { eventId: 2 }, coverage_complete: true });
    expect(Number((await sql`SELECT COUNT(*) AS n FROM events WHERE session_id='event-source' AND id=3`)[0]!.n)).toBe(1);
    process.stdout.write(`${EVENTS_EXPORTED}\n`);
  });

  it("runs the event page inside a read-only transaction", async () => {
    await expect(sql.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;
      await tx`INSERT INTO sessions(session_id,node_id) VALUES ('must-not-write','node')`;
    })).rejects.toThrow(/read.only transaction/i);
    expect(Number((await sql`SELECT COUNT(*) AS n FROM sessions WHERE session_id='must-not-write'`)[0]!.n)).toBe(0);
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

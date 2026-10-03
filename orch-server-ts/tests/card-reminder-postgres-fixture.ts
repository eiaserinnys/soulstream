import { readFile } from "node:fs/promises";
import type { PagePostgresHarness } from "./page/page_postgres_harness.js";

/** Existing durable delivery tables from the canonical schema, never a production DB. */
export async function prepareCardReminderSchema(h: PagePostgresHarness) {
  await h.sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS notify_completion BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS termination_detail TEXT, ADD COLUMN IF NOT EXISTS termination_reason TEXT,
    ADD COLUMN IF NOT EXISTS termination_event_id INTEGER`;
  const schema = await readFile(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8");
  for (const table of ["session_deliveries", "session_delivery_relation_consumptions", "event_ingress_receipts"]) {
    const ddl = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))?.[0];
    if (!ddl) throw new Error(`Actual schema is missing ${table}`);
    await h.sql.unsafe(ddl);
  }
  await h.sql.unsafe(schema.match(/ALTER TABLE session_deliveries\n    ADD COLUMN IF NOT EXISTS aggregate_state[\s\S]*?;/)![0]);
}

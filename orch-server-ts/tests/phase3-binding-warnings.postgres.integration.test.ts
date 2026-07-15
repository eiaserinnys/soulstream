import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLiveDbCatalogRepository } from "../src/index.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page/page_postgres_harness.js";

describe("Phase 3 binding warning browser projection PostgreSQL integration", () => {
  let harness: PagePostgresHarness;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    await harness.sql.unsafe(`
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'running';
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
      CREATE OR REPLACE FUNCTION session_count(p_filters JSONB DEFAULT NULL)
      RETURNS BIGINT LANGUAGE sql STABLE AS $$ SELECT COUNT(*) FROM sessions $$;
      CREATE OR REPLACE FUNCTION session_get_all(
        p_filters JSONB DEFAULT NULL,
        p_limit INTEGER DEFAULT NULL,
        p_offset INTEGER DEFAULT NULL
      ) RETURNS SETOF sessions LANGUAGE sql STABLE AS $$
        SELECT * FROM sessions ORDER BY updated_at DESC LIMIT p_limit OFFSET COALESCE(p_offset, 0)
      $$;
    `);
  }, 45_000);

  afterAll(async () => {
    await harness.cleanup();
  }, 15_000);

  it("reads the durable row after response loss and clears warnings after replay", async () => {
    await harness.sql`
      INSERT INTO sessions (session_id, status) VALUES ('sess-browser-recovery', 'completed')
    `;
    await harness.sql`
      INSERT INTO session_page_bindings (
        session_id, node_id, daily_date, session_type, page_state, legacy_state
      ) VALUES (
        'sess-browser-recovery', 'test-node', '2026-07-13', 'agent',
        'manual_repair', 'pending'
      )
    `;
    const repository = createLiveDbCatalogRepository({ sql: harness.liveSql });

    await expect(repository.loadSessionSnapshot()).resolves.toMatchObject({
      sessions: [{
        agentSessionId: "sess-browser-recovery",
        status: "completed",
        bindingWarnings: [
          { code: "PAGE_BINDING_MANUAL_REPAIR" },
          { code: "LEGACY_PROJECTION_PENDING" },
        ],
      }],
      total: 1,
    });

    await harness.sql`
      UPDATE session_page_bindings
      SET page_state = 'bound', legacy_state = 'completed'
      WHERE session_id = 'sess-browser-recovery'
    `;
    await expect(repository.loadSessionSnapshot()).resolves.toMatchObject({
      sessions: [{ bindingWarnings: [] }],
    });
    await repository.close();
  });
});

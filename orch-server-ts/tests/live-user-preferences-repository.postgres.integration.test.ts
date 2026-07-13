import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createLiveUserPreferencesRepository,
  normalizeUserPreferences,
} from "../src/index.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page/page_postgres_harness.js";

describe("live user preferences repository PostgreSQL integration", () => {
  let harness: PagePostgresHarness;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    await harness.sql.unsafe(`
      CREATE TABLE users (
        email TEXT PRIMARY KEY
      );
      CREATE TABLE user_preferences (
        email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
        prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
        background_blob BYTEA,
        background_mime TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO users (email) VALUES ('user@example.com');
    `);
  }, 45_000);

  afterAll(async () => {
    await harness.cleanup();
  }, 15_000);

  it("stores preferences as a JSONB object instead of a JSON string scalar", async () => {
    const repository = createLiveUserPreferencesRepository({
      sqlResolver: {
        resolveSql: async () => harness.liveSql,
        close: async () => undefined,
      },
    });
    const prefs = normalizeUserPreferences({
      appearance: "dark",
      wallpaper: { mode: "metal" },
      glass: { enabled: false },
    });

    await repository.put("user@example.com", prefs, { clearBackground: false });

    const [row] = await harness.sql<{
      prefs_type: string;
      appearance: string;
      wallpaper_mode: string;
    }[]>`
      SELECT
        jsonb_typeof(prefs) AS prefs_type,
        prefs->>'appearance' AS appearance,
        prefs->'wallpaper'->>'mode' AS wallpaper_mode
      FROM user_preferences
      WHERE email = 'user@example.com'
    `;
    expect(row).toEqual({
      prefs_type: "object",
      appearance: "dark",
      wallpaper_mode: "metal",
    });
  });
});

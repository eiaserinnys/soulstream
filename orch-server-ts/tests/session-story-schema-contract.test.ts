import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("session_digests schema contract", () => {
  it("keeps the versioned migration identical to the canonical schema block", () => {
    const schema = readFileSync(
      fileURLToPath(
        new URL("../../packages/db-schema/sql/schema.sql", import.meta.url),
      ),
      "utf8",
    );
    const migration = readFileSync(
      fileURLToPath(
        new URL(
          "../../packages/db-schema/sql/migrations/051_session_digests.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    ).trim();
    const firstStatement = "CREATE TABLE IF NOT EXISTS session_digests (";
    const lastStatement =
      "ALTER TABLE session_digests ADD COLUMN IF NOT EXISTS updated_at "
      + "TIMESTAMPTZ NOT NULL DEFAULT NOW();";
    const start = schema.indexOf(firstStatement);
    const end = schema.indexOf(lastStatement, start) + lastStatement.length;

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(migration).toBe(schema.slice(start, end));
    expect(migration).toMatch(
      /session_id\s+TEXT PRIMARY KEY REFERENCES sessions\(session_id\) ON DELETE CASCADE/,
    );
  });
});

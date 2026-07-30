import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("session_digests schema contract", () => {
  it("keeps both the fresh-install table and idempotent ALTER path in schema.sql", () => {
    const schema = readFileSync(
      fileURLToPath(
        new URL("../../packages/db-schema/sql/schema.sql", import.meta.url),
      ),
      "utf8",
    );

    expect(schema).toContain("CREATE TABLE IF NOT EXISTS session_digests");
    for (const column of [
      "narrative",
      "highlight",
      "narrative_through_event_id",
      "fold_count",
      "version",
      "created_at",
      "updated_at",
    ]) {
      expect(schema).toContain(
        `ALTER TABLE session_digests ADD COLUMN IF NOT EXISTS ${column}`,
      );
    }
    expect(schema).toMatch(
      /session_id\s+TEXT PRIMARY KEY REFERENCES sessions\(session_id\) ON DELETE CASCADE/,
    );
  });
});

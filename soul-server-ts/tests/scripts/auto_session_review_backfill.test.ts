import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../../packages/db-schema/sql/backfills/20260715_auto_session_review_skip.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("automatic session review backfill", () => {
  it("targets only terminal pending reviews with direct non-user evidence", () => {
    expect(sql).toContain("sessions.review_state = 'needs_review'");
    expect(sql).toContain(
      "sessions.status IN ('completed', 'error', 'interrupted')",
    );
    expect(sql).toContain("source IN (");
    expect(sql).toContain("'agent'");
    expect(sql).toContain("'system'");
    expect(sql).toContain("source = 'browser'");
    expect(sql).toContain("caller_info ->> 'user_id'");
    expect(sql).toContain("caller_info ->> 'email'");
    expect(sql).toContain("caller_info ->> 'display_name'");
  });

  it("reuses the existing acknowledged state without schema changes", () => {
    expect(sql).toContain("review_required = FALSE");
    expect(sql).toContain("review_state = 'acknowledged'");
    expect(sql).not.toMatch(/\b(?:ALTER|CREATE|DROP)\b/i);
  });
});

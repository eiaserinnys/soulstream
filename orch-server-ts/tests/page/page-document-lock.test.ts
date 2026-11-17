import { it } from "vitest";

// The named seal entry runs the PostgreSQL suite against the dedicated URL.
// CI's PostgreSQL job discovers the suite by its conventional filename.
if (process.env.TEST_DATABASE_URL?.trim()) {
  await import("./page-document-lock.postgres.test.js");
} else {
  it.skip("requires TEST_DATABASE_URL for the named seal entry", () => {});
}

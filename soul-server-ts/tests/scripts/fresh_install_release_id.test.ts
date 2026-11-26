import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrateScript = resolve(
  fileURLToPath(import.meta.url),
  "../../../../packages/db-schema/scripts/migrate.mjs",
);

describe("fresh-install without a release id", () => {
  it("names the missing variable and shows an example before touching the database", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fresh-install-release-id-"));
    const result = spawnSync(process.execPath, [migrateScript, "fresh-install"], {
      cwd,
      encoding: "utf8",
      // No Postgres is reachable on port 1: the failure must come before any connection.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: cwd,
        DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
      },
    });

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stderr.trim().split("\n").at(-1) ?? "{}") as {
      error?: { message?: string };
    };
    expect(report.error?.message).toContain("SOULSTREAM_RELEASE_ID");
    expect(report.error?.message).toContain("SOULSTREAM_RELEASE_ID=local-1");
  });
});

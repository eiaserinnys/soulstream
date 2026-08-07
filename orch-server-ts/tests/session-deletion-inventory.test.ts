import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PRODUCTION_SOURCE_ROOTS = [
  "orch-server-ts/src",
  "soul-server-ts/src",
  "unified-dashboard/client",
];

describe("session deletion ingress inventory", () => {
  it("keeps every production relational delete behind SessionDeletionRepository", () => {
    const directDeleteHits = PRODUCTION_SOURCE_ROOTS.flatMap((root) =>
      sourceFiles(resolve(REPO_ROOT, root)).flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return /SELECT\s+session_delete\s*\(|DELETE\s+FROM\s+sessions\b/i.test(source)
          ? [relative(REPO_ROOT, path)]
          : [];
      })
    );

    expect(directDeleteHits).toEqual([
      "orch-server-ts/src/session/session_deletion_repository.ts",
    ]);
  });

  it("pins the HTTP, MCP, worker, persistence-host, and DB guard entrypoints", () => {
    expect(source("unified-dashboard/client/lib/delete-session.ts")).toContain(
      'method: "DELETE"',
    );
    expect(source("orch-server-ts/src/session/session_catalog_routes.ts")).toContain(
      '"/api/sessions/:session_id"',
    );
    expect(source("soul-server-ts/src/mcp/tools/catalog.ts")).toContain(
      '"delete_session"',
    );
    expect(source("soul-server-ts/src/task/task_lifecycle_route.ts")).toContain(
      "this.deps.sessionMutations.deleteSession",
    );
    expect(source("orch-server-ts/src/control_plane/persistence_host_routes.ts")).toContain(
      'delete_session: ["sessionMutations", null, "deleteSession"]',
    );
    expect(source("packages/db-schema/sql/schema.sql")).toContain(
      "CREATE TRIGGER board_assert_session_refs_removed_trigger",
    );
  });
});

function source(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  }).sort();
}

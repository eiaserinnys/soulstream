import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ORCH_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = resolve(ORCH_ROOT, "..");

describe("board Y.Doc snapshot canonical contract", () => {
  it("keeps board_yjs_updates exclusive to page persistence", () => {
    const consumers = ["src", "scripts"]
      .flatMap((directory) => listTypeScriptFiles(resolve(ORCH_ROOT, directory)))
      .filter((path) => readFileSync(path, "utf8").includes("board_yjs_updates"))
      .map((path) => relative(ORCH_ROOT, path))
      .sort();

    expect(consumers).toEqual(["src/page/page_repository.ts"]);
    expect(readFileSync(resolve(ORCH_ROOT, consumers[0]!), "utf8"))
      .toContain("INSERT INTO board_yjs_updates");
  });

  it("pins every board_items write-owning source file to an exact allowlist", () => {
    const writers = listSourceFiles(REPO_ROOT)
      // Versioned migrations are immutable history; schema.sql owns installed runtime functions.
      .filter((path) => !relative(REPO_ROOT, path).startsWith(
        "packages/db-schema/sql/migrations/"
      ))
      .filter((path) => !relative(REPO_ROOT, path).split("/").includes("tests"))
      .filter((path) => BOARD_ITEMS_WRITE_PATTERN.test(readFileSync(path, "utf8")))
      .map((path) => relative(REPO_ROOT, path))
      .sort();

    expect(writers).toEqual([
      "orch-server-ts/src/board-yjs/board_yjs_replica_sync.ts",
      "orch-server-ts/src/folders/folder_project_identity_repository.ts",
      "orch-server-ts/src/runtime/live_board_asset_route_provider.ts",
      "orch-server-ts/src/runtime/live_folder_route_provider.ts",
      "packages/db-schema/sql/schema.sql",
      "packages/soul-common/src/soul_common/db/postgres/folders.py",
    ]);
  });

  it("pins every snapshot writer and keeps application writes behind revision CAS", () => {
    const writers = listSourceFiles(REPO_ROOT)
      .filter((path) => !relative(REPO_ROOT, path).startsWith(
        "packages/db-schema/sql/migrations/"
      ))
      .filter((path) => !relative(REPO_ROOT, path).split("/").includes("tests"))
      .filter((path) => BOARD_YJS_SNAPSHOT_WRITE_PATTERN.test(readFileSync(path, "utf8")))
      .map((path) => relative(REPO_ROOT, path))
      .sort();

    expect(writers).toEqual([
      "orch-server-ts/src/board-yjs/board_yjs_repository.ts",
      "orch-server-ts/src/board-yjs/board_yjs_snapshot_store.ts",
      "orch-server-ts/src/page/page_repository_projection.ts",
    ]);

    const snapshotStore = readFileSync(
      resolve(ORCH_ROOT, "src/board-yjs/board_yjs_snapshot_store.ts"),
      "utf8",
    );
    expect(snapshotStore).toContain("AND revision = ${input.expectedRevision}");
    expect(snapshotStore).toContain("ON CONFLICT (name) DO NOTHING");
    expect(snapshotStore).toContain("syncBoardYjsReplicaWithSql");
    expect(snapshotStore).not.toContain("ON CONFLICT (name) DO UPDATE");
  });
});

const BOARD_ITEMS_WRITE_PATTERN = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+board_items\b/i;
const BOARD_YJS_SNAPSHOT_WRITE_PATTERN =
  /\b(?:INSERT\s+INTO\s+board_yjs_documents|UPDATE\s+board_yjs_documents\s+SET\s+snapshot\b)/i;

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return entry.isFile() && /\.(?:[cm]?[jt]sx?|py|sql)$/.test(entry.name) ? [path] : [];
  });
}

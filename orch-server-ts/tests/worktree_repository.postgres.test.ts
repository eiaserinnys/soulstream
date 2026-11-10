import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { WorktreeRepository } from "../src/control_plane/repositories/worktree_repository.js";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";

const hasPostgres = Boolean(process.env.TEST_DATABASE_URL?.trim()) ||
  spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const describePostgres = hasPostgres ? describe : describe.skip;

describePostgres("WorktreeRepository.list in PostgreSQL", () => {
  let harness: FullSchemaPostgresHarness;
  let repository: WorktreeRepository;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    repository = new WorktreeRepository(harness.sql as unknown as SqlClient);
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("derives caller ownership and the active session in the list row", async () => {
    await harness.sql`
      INSERT INTO folders (id, name) VALUES
        ('actor-folder', 'actor folder'),
        ('other-folder', 'other folder')
    `;
    const worktree = (
      id: string,
      ownerFolderId: string | null,
      createdBySessionId: string,
      createdAt: string,
    ) => ({
      id,
      node_id: "node-a",
      repo_id: "demo",
      canonical_path: `/projects/demo--${id}`,
      branch: id,
      created_from_sha: "a".repeat(40),
      owner_folder_id: ownerFolderId,
      created_by_session_id: createdBySessionId,
      created_at: createdAt,
    });
    const worktrees = [
      worktree("wt-folder-foreign", "other-folder", "actor", "2026-01-05T00:00:00Z"),
      worktree("wt-created", null, "actor", "2026-01-03T00:00:00Z"),
      worktree("wt-unrelated", null, "other", "2026-01-02T00:00:00Z"),
      worktree("wt-folder-own", "actor-folder", "other", "2026-01-02T00:00:00Z"),
      worktree("wt-lineage", null, "caller", "2026-01-04T00:00:00Z"),
    ];
    for (const row of worktrees) {
      await harness.sql`
        INSERT INTO worktrees (
          id, node_id, repo_id, canonical_path, branch, created_from_sha,
          owner_folder_id, created_by_session_id, worktree_identity, created_at
        ) VALUES (
          ${row.id}, ${row.node_id}, ${row.repo_id}, ${row.canonical_path},
          ${row.branch}, ${row.created_from_sha}, ${row.owner_folder_id},
          ${row.created_by_session_id}, ${row.id}, ${row.created_at}
        )
      `;
    }
    await harness.sql`
      INSERT INTO sessions (session_id, folder_id, caller_session_id) VALUES
        ('actor', 'actor-folder', 'caller'),
        ('caller', 'other-folder', NULL),
        ('other', 'other-folder', NULL)
    `;
    await harness.sql`
      INSERT INTO sessions (session_id, worktree_id, status, created_at) VALUES
        ('session-done', 'wt-created', 'completed', '2025-12-31T00:00:00Z'),
        ('session-running', 'wt-created', 'running', '2026-01-03T00:00:00Z')
    `;

    const rows = await repository.list({ actorSessionId: "actor", nodeId: "node-a" });

    expect(rows.map((row) => [row.id, row.mutableByCaller, row.activeSessionId])).toEqual([
      ["wt-folder-own", true, null],
      ["wt-unrelated", false, null],
      ["wt-created", true, "session-running"],
      ["wt-lineage", true, null],
      ["wt-folder-foreign", false, null],
    ]);
    expect(rows[0]).toMatchObject({
      nodeId: "node-a",
      ownerFolderId: "actor-folder",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
  }, 30_000);
});

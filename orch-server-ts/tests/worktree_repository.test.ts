// Follows the tagged-SQL stub pattern in session-deletion-repository.test.ts.
import { describe, expect, it } from "vitest";
import { WorktreeRepository } from "../src/control_plane/repositories/worktree_repository.js";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";

function fixture(nodeId = "node-a", active = false) {
  const now = new Date("2026-10-01T00:00:00Z");
  let row = { id: "wt", node_id: nodeId, repo_id: "demo", canonical_path: "/projects/demo--feature",
    branch: "feature", created_from_sha: "a".repeat(40), owner_folder_id: "foreign-folder",
    created_by_session_id: "owner", state: "ready", setup_mode: "none", setup_required: false,
    setup_status: "not_requested", managed_paths: [], worktree_identity: "wt",
    branch_delete_expected_sha: null as string | null, branch_delete_marker_ref: null,
    last_error_code: null, last_error_message: null, created_at: now, updated_at: now,
    removed_at: null as Date | null, branch_deleted_at: null,
    last_session_activity_at: now, linked_cards_closed: true };
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const sql = Object.assign(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?"); calls.push({ query, values });
    if (query.includes("FROM worktrees")) return [row];
    if (query.includes("SELECT folder_id")) return [{ folder_id: "not-owner" }];
    if (query.includes("SELECT session_id FROM sessions")) return active ? [{ session_id: "live" }] : [];
    if (query.includes("UPDATE worktrees")) {
      if (query.includes("state = 'removing'")) row = { ...row, state: "removing", branch_delete_expected_sha: values[0] as string | null };
      if (query.includes("state = 'ready'")) row = { ...row, state: "ready" };
      if (query.includes("state = 'removed'")) row = { ...row, state: "removed", removed_at: now };
      return [row];
    }
    return [];
  }, { begin: async (fn: (tx: unknown) => unknown) => fn(sql), json: (value: unknown) => value }) as unknown as SqlClient;
  return { repository: new WorktreeRepository(sql), calls };
}

describe("WorktreeRepository list", () => {
  it("computes caller mutability and the active session in one SQL statement", async () => {
    const now = new Date("2026-10-01T00:00:00Z");
    const row = { id: "wt", node_id: "node-a", repo_id: "demo", canonical_path: "/projects/demo--feature",
      branch: "feature", created_from_sha: "a".repeat(40), owner_folder_id: null,
      created_by_session_id: "owner", state: "ready", setup_mode: "none", setup_required: false,
      setup_status: "not_requested", managed_paths: [], worktree_identity: "wt",
      branch_delete_expected_sha: null, branch_delete_marker_ref: null,
      last_error_code: null, last_error_message: null, created_at: now, updated_at: now,
      removed_at: null, branch_deleted_at: null,
      mutable_by_caller: true, active_session_id: "live" };
    const calls: Array<{ query: string; values: unknown[] }> = [];
    const sql = Object.assign(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ query: parts.join("?"), values });
      return [row];
    }, { begin: async (fn: (tx: unknown) => unknown) => fn(sql), json: (value: unknown) => value }) as unknown as SqlClient;
    const repository = new WorktreeRepository(sql);

    const result = await repository.list({
      actorSessionId: "actor",
      nodeId: "node-a",
      repoId: "demo",
      worktreeId: "wt",
    });

    expect(calls).toHaveLength(1);
    expect(result).toEqual([expect.objectContaining({ id: "wt", mutableByCaller: true, activeSessionId: "live" })]);
    const { query, values } = calls[0]!;
    expect(values).toContain("node-a");
    expect(values).toContain("actor");
    expect(query).toMatch(/WITH RECURSIVE lineage\(session_id\) AS \([\s\S]*SELECT \?::TEXT[\s\S]*\bUNION\b[\s\S]*sessions\.caller_session_id/);
    expect(query).toMatch(/CASE[\s\S]*w\.owner_folder_id IS NOT NULL THEN COALESCE\([\s\S]*w\.owner_folder_id = \([\s\S]*SELECT folder_id FROM sessions WHERE session_id = \?/);
    expect(query).toMatch(/EXISTS \([\s\S]*FROM lineage WHERE session_id = w\.created_by_session_id/);
    expect(query).toMatch(/SELECT session_id FROM sessions[\s\S]*worktree_id = w\.id AND status IN \('initializing', 'running'\)[\s\S]*ORDER BY created_at LIMIT 1/);
    expect(query).toMatch(/FROM worktrees w[\s\S]*w\.node_id = \?/);
    expect(query).toMatch(/ORDER BY w\.created_at, w\.id\s*$/);
  });
});

describe("WorktreeRepository sweeper", () => {
  it("queries ready node-local candidates, active bindings, linked activity and closed cards in SQL", async () => {
    const { repository, calls } = fixture();
    const result = await repository.sweepCandidates({ nodeId: "node-a" });
    expect(result).toEqual([expect.objectContaining({ id: "wt", lastSessionActivityAt: "2026-10-01T00:00:00.000Z", linkedCardsClosed: true })]);
    const call = calls[0]!;
    expect(call.values).toContain("node-a");
    expect(call.query).toMatch(/WITH candidates AS \([\s\S]*SELECT w\.\* FROM worktrees w[\s\S]*w\.node_id = \? AND w\.state = 'ready'/);
    expect(call.query).toMatch(/NOT EXISTS[\s\S]*worktree_id = w\.id[\s\S]*'initializing', 'running'/);
    expect(call.query).toMatch(/FROM candidates c JOIN sessions s ON s\.worktree_id = c\.id/);
    expect(call.query).toMatch(/\bUNION\s+SELECT c\.id, s\.session_id, s\.updated_at, s\.card_id\s+FROM candidates c JOIN sessions s ON s\.session_id = c\.created_by_session_id/);
    expect(call.query).toMatch(/GREATEST\(c\.created_at,\s*activity\.last_session_activity_at\)/);
    expect(call.query).toMatch(/MAX\(l\.updated_at\) AS last_session_activity_at/);
    expect(call.query).toMatch(/COUNT\(cd\.id\) > 0/);
    expect(call.query).toMatch(/BOOL_AND\(cd\.status IN \('done', 'cancelled'\)\)/);
    expect(call.query).toMatch(/GROUP BY l\.worktree_id[\s\S]*\) activity ON activity\.worktree_id = c\.id/);
    expect(call.query).toMatch(/COALESCE\(activity\.linked_cards_closed, false\)/);
    expect(call.query).toMatch(/ORDER BY c\.created_at, c\.id/);
    expect(call.query).not.toMatch(/s\.worktree_id = w\.id OR s\.session_id = w\.created_by_session_id/);
    expect(call.query).not.toContain("w.updated_at");
  });

  it("allows the node sweeper to remove across folders and restore failures", async () => {
    const { repository } = fixture();
    const actor = { sweeperNodeId: "node-a", worktreeId: "wt" };
    expect(await repository.beginRemove({ ...actor, expectedSha: "a".repeat(40) })).toMatchObject({ state: "removing" });
    expect(await repository.restoreReady({ ...actor, errorCode: "FAIL", errorMessage: "failure" })).toMatchObject({ state: "ready" });
    await repository.beginRemove({ ...actor, expectedSha: "a".repeat(40) });
    expect(await repository.finishRemove(actor)).toMatchObject({ state: "removed" });
  });

  it.each(["beginRemove", "restoreReady", "finishRemove"] as const)("rejects another node for %s", async (method) => {
    const { repository, calls } = fixture("node-b");
    await expect(repository[method]({ sweeperNodeId: "node-a", worktreeId: "wt", expectedSha: "a", errorCode: "FAIL", errorMessage: "failure" }))
      .rejects.toMatchObject({ statusCode: 403, code: "WORKTREE_NODE_MISMATCH" });
    expect(calls.some(call => call.query.includes("UPDATE worktrees"))).toBe(false);
  });

  it("keeps the active-session race gate for the sweeper", async () => {
    const { repository } = fixture("node-a", true);
    await expect(repository.beginRemove({ sweeperNodeId: "node-a", worktreeId: "wt", expectedSha: "a" }))
      .rejects.toMatchObject({ code: "WORKTREE_IN_USE" });
  });

  it("keeps session ownership checks and rejects missing or ambiguous actors", async () => {
    const { repository } = fixture();
    await expect(repository.beginRemove({ actorSessionId: "foreign", worktreeId: "wt", expectedSha: "a" }))
      .rejects.toMatchObject({ code: "WORKTREE_NOT_OWNED" });
    for (const actor of [{}, { actorSessionId: "foreign", sweeperNodeId: "node-a" }]) {
      await expect(repository.beginRemove({ ...actor, worktreeId: "wt", expectedSha: "a" } as never))
        .rejects.toMatchObject({ statusCode: 422 });
    }
  });
});

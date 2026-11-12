// Follows the tagged-SQL stub pattern in session-deletion-repository.test.ts.
import { describe, expect, it } from "vitest";
import {
  WorktreeRepository,
  decideWorktreeOwnership,
  lockWorktreeForSessionBinding,
} from "../src/control_plane/repositories/worktree_repository.js";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";

type LineageRow = { kind: "session" | "card"; id: string };
type CreatorRow = { session_id: string; card_id: string | null; status: string; updated_at: Date };
type CardRow = { id: string; status: string };

type FixtureOptions = {
  nodeId?: string;
  active?: boolean;
  state?: "ready" | "removing" | "removed";
  ownerFolderId?: string | null;
  createdBySessionId?: string;
  lineage?: LineageRow[];
  creators?: CreatorRow[];
  cards?: CardRow[];
};

function fixture(options: FixtureOptions = {}) {
  const now = new Date("2026-10-01T00:00:00Z");
  const nodeId = options.nodeId ?? "node-a";
  let row = { id: "wt", node_id: nodeId, repo_id: "demo", canonical_path: "/projects/demo--feature",
    branch: "feature", created_from_sha: "a".repeat(40),
    owner_folder_id: options.ownerFolderId === undefined ? "foreign-folder" : options.ownerFolderId,
    created_by_session_id: options.createdBySessionId ?? "owner",
    state: options.state ?? "ready", setup_mode: "none", setup_required: false,
    setup_status: "not_requested", managed_paths: [], worktree_identity: "wt",
    branch_delete_expected_sha: null as string | null, branch_delete_marker_ref: null,
    last_error_code: null, last_error_message: null, created_at: now, updated_at: now,
    removed_at: null as Date | null, branch_deleted_at: null,
    last_session_activity_at: now, linked_cards_closed: true,
    active_session_id: options.active ? "live" : null };
  const lineage: LineageRow[] = options.lineage ?? [{ kind: "session", id: "actor" }];
  const creators: CreatorRow[] = options.creators
    ?? [{ session_id: "owner", card_id: null, status: "running", updated_at: now }];
  const cards: CardRow[] = options.cards ?? [];
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const sql = Object.assign(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?"); calls.push({ query, values });
    if (query.includes("UPDATE worktrees")) {
      if (query.includes("state = 'removing'")) row = { ...row, state: "removing", branch_delete_expected_sha: values[0] as string | null };
      if (query.includes("state = 'ready'")) row = { ...row, state: "ready" };
      if (query.includes("state = 'removed'")) row = { ...row, state: "removed", removed_at: now };
      if (query.includes("branch_delete_expected_sha = ?")) row = { ...row, branch_delete_expected_sha: values[0] as string };
      return [row];
    }
    if (query.includes("WITH RECURSIVE lineage")) return lineage;
    if (query.includes("SELECT session_id, card_id, status, updated_at")) return creators;
    if (query.includes("SELECT id, status FROM cards")) return cards;
    if (query.includes("FROM worktrees")) return [row];
    if (query.includes("SELECT session_id FROM sessions")) return options.active ? [{ session_id: "live" }] : [];
    return [];
  }, { begin: async (fn: (tx: unknown) => unknown) => fn(sql), json: (value: unknown) => value }) as unknown as SqlClient;
  return { repository: new WorktreeRepository(sql), calls, sql, row: () => row };
}

const CARD = "card-c";
const OTHER_CARD = "card-d";
const RUNNING = "running";
const DONE = "done";

describe("WorktreeRepository ownership decision", () => {
  type DecisionInput = Parameters<typeof decideWorktreeOwnership>[0];
  const base: DecisionInput = {
    actorSessionId: "actor",
    lineage: new Set(["actor"]),
    lineageCardIds: new Set<string>(),
    createdBySessionId: "creator",
    creator: null,
    cardStatus: null,
    nowMs: Date.parse("2026-11-13T00:00:00Z"),
  };

  function decide(overrides: Partial<Parameters<typeof decideWorktreeOwnership>[0]>) {
    return decideWorktreeOwnership({ ...base, ...overrides });
  }

  it("lets the card's sessions own the worktree the card created", () => {
    expect(decide({
      lineage: new Set(["assignee", "child"]),
      lineageCardIds: new Set([CARD]),
      creator: { cardId: CARD, status: RUNNING, updatedAt: new Date(base.nowMs) },
      cardStatus: RUNNING,
    })).toEqual({ owns: true, released: false });
  });

  it("lets a replacement assignee own through cards.assignee_session_id", () => {
    expect(decide({
      lineage: new Set(["new-assignee", "new-child"]),
      lineageCardIds: new Set([CARD]),
      creator: { cardId: CARD, status: RUNNING, updatedAt: new Date(base.nowMs) },
      cardStatus: RUNNING,
    })).toEqual({ owns: true, released: false });
  });

  it("denies another card even when both sit in the same folder", () => {
    expect(decide({
      lineage: new Set(["other-card-session"]),
      lineageCardIds: new Set([OTHER_CARD]),
      creator: { cardId: CARD, status: RUNNING, updatedAt: new Date(base.nowMs) },
      cardStatus: RUNNING,
    })).toEqual({ owns: false, released: false });
  });

  it("releases a closed card for removal while keeping ownership with the card", () => {
    const creator = { cardId: CARD, status: "done", updatedAt: new Date(base.nowMs) };
    expect(decide({
      lineage: new Set(["other-card-session"]),
      lineageCardIds: new Set([OTHER_CARD]),
      creator,
      cardStatus: DONE,
    })).toEqual({ owns: false, released: true });
    expect(decide({
      lineage: new Set(["owner-session"]),
      lineageCardIds: new Set([CARD]),
      creator,
      cardStatus: DONE,
    })).toEqual({ owns: true, released: true });
    expect(decide({
      lineage: new Set(["other-card-session"]),
      lineageCardIds: new Set([OTHER_CARD]),
      creator,
      cardStatus: "cancelled",
    })).toEqual({ owns: false, released: true });
  });

  it("keeps cardless worktrees with the creator and its descendants", () => {
    const creator = { cardId: null, status: RUNNING, updatedAt: new Date(base.nowMs) };
    expect(decide({ lineage: new Set(["creator", "child"]), creator, cardStatus: null }))
      .toEqual({ owns: true, released: false });
    expect(decide({ lineage: new Set(["stranger"]), creator, cardStatus: null }))
      .toEqual({ owns: false, released: false });
  });

  it("releases a cardless worktree only after the creator has been idle for a day", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(decide({ lineage: new Set(["stranger"]), creator: null, cardStatus: null }))
      .toEqual({ owns: false, released: true });
    expect(decide({
      lineage: new Set(["stranger"]),
      creator: { cardId: null, status: "done", updatedAt: new Date(base.nowMs - day - 1) },
      cardStatus: null,
    })).toEqual({ owns: false, released: true });
    expect(decide({
      lineage: new Set(["stranger"]),
      creator: { cardId: null, status: "done", updatedAt: new Date(base.nowMs - day + 1) },
      cardStatus: null,
    })).toEqual({ owns: false, released: false });
    expect(decide({
      lineage: new Set(["stranger"]),
      creator: { cardId: null, status: RUNNING, updatedAt: new Date(base.nowMs - day - 1) },
      cardStatus: null,
    })).toEqual({ owns: false, released: false });
  });
});

describe("WorktreeRepository list", () => {
  it("derives both caller flags from card ownership and the active session", async () => {
    const { repository, calls } = fixture({
      ownerFolderId: "foreign-folder",
      createdBySessionId: "creator",
      lineage: [{ kind: "session", id: "actor" }, { kind: "card", id: CARD }],
      creators: [{ session_id: "creator", card_id: CARD, status: RUNNING, updated_at: new Date("2026-10-01T00:00:00Z") }],
      cards: [{ id: CARD, status: RUNNING }],
      active: true,
    });

    const result = await repository.list({
      actorSessionId: "actor",
      nodeId: "node-a",
      repoId: "demo",
      worktreeId: "wt",
    });

    expect(result).toEqual([expect.objectContaining({
      id: "wt",
      mutableByCaller: true,
      removableByCaller: true,
      activeSessionId: "live",
    })]);
    const { query, values } = calls[0]!;
    expect(values).toContain("node-a");
    expect(query).toMatch(/SELECT session_id FROM sessions[\s\S]*worktree_id = w\.id AND status IN \('initializing', 'running'\)[\s\S]*ORDER BY created_at LIMIT 1/);
    expect(query).toMatch(/FROM worktrees w[\s\S]*w\.node_id = \?/);
    expect(query).toMatch(/ORDER BY w\.created_at, w\.id\s*$/);
    expect(query).not.toMatch(/owner_folder_id\s*=/);
    const lineageCall = calls.find((call) => call.query.includes("WITH RECURSIVE lineage"))!;
    expect(lineageCall.values).toContain("actor");
    expect(lineageCall.query).toMatch(/SELECT 'card' AS kind, s\.card_id AS id[\s\S]*FROM sessions s JOIN lineage l/);
    expect(lineageCall.query).toMatch(/SELECT 'card' AS kind, c\.id AS id[\s\S]*FROM cards c JOIN lineage l ON l\.session_id = c\.assignee_session_id/);
  });

  it("denies another card in the same folder and a released worktree's mutability", async () => {
    const { repository } = fixture({
      ownerFolderId: "same-folder",
      createdBySessionId: "creator",
      lineage: [{ kind: "session", id: "actor" }, { kind: "card", id: OTHER_CARD }],
      creators: [{ session_id: "creator", card_id: CARD, status: "done", updated_at: new Date("2026-10-01T00:00:00Z") }],
      cards: [{ id: CARD, status: DONE }],
    });

    const result = await repository.list({ actorSessionId: "actor", nodeId: "node-a" });

    expect(result).toEqual([expect.objectContaining({
      id: "wt",
      mutableByCaller: false,
      removableByCaller: true,
    })]);
  });
});

describe("WorktreeRepository mutation ownership", () => {
  it("lets the owning session remove and restore", async () => {
    const { repository } = fixture({
      lineage: [{ kind: "session", id: "actor" }, { kind: "card", id: CARD }],
      creators: [{ session_id: "owner", card_id: CARD, status: RUNNING, updated_at: new Date("2026-10-01T00:00:00Z") }],
      cards: [{ id: CARD, status: RUNNING }],
    });
    expect(await repository.beginRemove({ actorSessionId: "actor", worktreeId: "wt", expectedSha: "a" }))
      .toMatchObject({ state: "removing" });
    expect(await repository.restoreReady({ actorSessionId: "actor", worktreeId: "wt", errorCode: "FAIL", errorMessage: "failure" }))
      .toMatchObject({ state: "ready" });
  });

  it("lets a released worktree be removed and its branch deleted by a stranger", async () => {
    const { repository } = fixture({
      state: "removed",
      lineage: [{ kind: "session", id: "actor" }],
      creators: [{ session_id: "owner", card_id: CARD, status: "done", updated_at: new Date("2026-10-01T00:00:00Z") }],
      cards: [{ id: CARD, status: DONE }],
    });
    expect(await repository.beginBranchDelete({
      actorSessionId: "actor", worktreeId: "wt", expectedSha: "a", markerRef: "refs/marker",
    })).toMatchObject({ state: "removed" });
  });

  it("keeps replacement ownership for setup changes and denies a released stranger", async () => {
    const released = fixture({
      lineage: [{ kind: "session", id: "actor" }],
      creators: [{ session_id: "owner", card_id: CARD, status: "done", updated_at: new Date("2026-10-01T00:00:00Z") }],
      cards: [{ id: CARD, status: DONE }],
    });
    await expect(released.repository.updateSetup({
      actorSessionId: "actor", worktreeId: "wt", setupStatus: "ready", managedPaths: [],
    })).rejects.toMatchObject({ code: "WORKTREE_NOT_OWNED" });

    const owns = fixture({
      lineage: [{ kind: "session", id: "actor" }, { kind: "card", id: CARD }],
      creators: [{ session_id: "owner", card_id: CARD, status: RUNNING, updated_at: new Date("2026-10-01T00:00:00Z") }],
      cards: [{ id: CARD, status: RUNNING }],
    });
    expect(await owns.repository.updateSetup({
      actorSessionId: "actor", worktreeId: "wt", setupStatus: "ready", managedPaths: [],
    })).toMatchObject({ id: "wt" });
  });

  it("keeps the active-session gate even for a released worktree", async () => {
    const { repository } = fixture({
      active: true,
      lineage: [{ kind: "session", id: "actor" }],
      creators: [{ session_id: "owner", card_id: CARD, status: "done", updated_at: new Date("2026-10-01T00:00:00Z") }],
      cards: [{ id: CARD, status: DONE }],
    });
    await expect(repository.beginRemove({ actorSessionId: "actor", worktreeId: "wt", expectedSha: "a" }))
      .rejects.toMatchObject({ code: "WORKTREE_IN_USE" });
  });

  it("rejects a session with neither ownership nor a release", async () => {
    const { repository } = fixture();
    await expect(repository.beginRemove({ actorSessionId: "foreign", worktreeId: "wt", expectedSha: "a" }))
      .rejects.toMatchObject({ code: "WORKTREE_NOT_OWNED" });
    for (const actor of [{}, { actorSessionId: "foreign", sweeperNodeId: "node-a" }]) {
      await expect(repository.beginRemove({ ...actor, worktreeId: "wt", expectedSha: "a" } as never))
        .rejects.toMatchObject({ statusCode: 422 });
    }
  });
});

describe("WorktreeRepository session binding ownership", () => {
  it("binds the replacement assignee that owns the card", async () => {
    const { sql } = fixture({
      ownerFolderId: null,
      lineage: [{ kind: "session", id: "new-assignee" }, { kind: "card", id: CARD }],
      creators: [{ session_id: "owner", card_id: CARD, status: RUNNING, updated_at: new Date("2026-10-01T00:00:00Z") }],
      cards: [{ id: CARD, status: RUNNING }],
    });
    await expect(lockWorktreeForSessionBinding(sql, {
      worktreeId: "wt",
      nodeId: "node-a",
      actorSessionId: "new-assignee",
      ownerFolderId: null,
    })).resolves.toMatchObject({ id: "wt", createdBySessionId: "owner" });
  });

  it("refuses binding to a released worktree even though removal is allowed", async () => {
    const { sql } = fixture({
      ownerFolderId: null,
      lineage: [{ kind: "session", id: "stranger" }],
      creators: [{ session_id: "owner", card_id: CARD, status: "done", updated_at: new Date("2026-10-01T00:00:00Z") }],
      cards: [{ id: CARD, status: DONE }],
    });
    await expect(lockWorktreeForSessionBinding(sql, {
      worktreeId: "wt",
      nodeId: "node-a",
      actorSessionId: "stranger",
      ownerFolderId: null,
    })).rejects.toMatchObject({ code: "WORKTREE_NOT_OWNED" });
  });

  it("keeps the folder mismatch check ahead of the ownership decision", async () => {
    const { sql } = fixture({
      ownerFolderId: "folder-x",
      lineage: [{ kind: "session", id: "actor" }, { kind: "card", id: CARD }],
      creators: [{ session_id: "owner", card_id: CARD, status: RUNNING, updated_at: new Date("2026-10-01T00:00:00Z") }],
      cards: [{ id: CARD, status: RUNNING }],
    });
    await expect(lockWorktreeForSessionBinding(sql, {
      worktreeId: "wt",
      nodeId: "node-a",
      actorSessionId: "actor",
      ownerFolderId: "folder-y",
    })).rejects.toMatchObject({ code: "WORKTREE_FOLDER_MISMATCH" });
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
    const { repository, calls } = fixture({ nodeId: "node-b" });
    await expect(repository[method]({ sweeperNodeId: "node-a", worktreeId: "wt", expectedSha: "a", errorCode: "FAIL", errorMessage: "failure" }))
      .rejects.toMatchObject({ statusCode: 403, code: "WORKTREE_NODE_MISMATCH" });
    expect(calls.some(call => call.query.includes("UPDATE worktrees"))).toBe(false);
  });

  it("keeps the active-session race gate for the sweeper", async () => {
    const { repository } = fixture({ active: true });
    await expect(repository.beginRemove({ sweeperNodeId: "node-a", worktreeId: "wt", expectedSha: "a" }))
      .rejects.toMatchObject({ code: "WORKTREE_IN_USE" });
  });
});

/**
 * §4 guard 계약 검증 — draft-card / card-status / worktree-create /
 * owned-worktree / message-recipient / create-local-session.
 *
 * 메시지 관계는 DB의 structural caller_session_id만 쓴다. 위조 인자·헤더는 근거가 아니다.
 */
import { describe, expect, it, vi } from "vitest";

import type { SessionExecutionChain } from "../../src/db/session_db_types.js";
import {
  runIsolationToolGuard,
  type IsolationGuardContext,
} from "../../src/mcp/isolation_tool_guards.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GRAND = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHILD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function row(sessionId: string, callerSessionId: string | null) {
  return { session_id: sessionId, caller_session_id: callerSessionId, model_preset: null, model: null, agent_id: null };
}

const chains: Record<string, SessionExecutionChain> = {
  [ME]: {
    root: row(ME, PARENT),
    ancestors: [row(PARENT, GRAND), row(GRAND, null)],
  },
  [PARENT]: {
    root: row(PARENT, GRAND),
    ancestors: [row(GRAND, null)],
  },
  [CHILD]: {
    root: row(CHILD, ME),
    ancestors: [row(ME, PARENT), row(PARENT, GRAND), row(GRAND, null)],
  },
  [OTHER]: {
    root: row(OTHER, null),
    ancestors: [],
  },
};

function context(overrides: {
  chains?: Record<string, SessionExecutionChain | Error>;
  ownsWorktree?: (sessionId: string, worktreeId: string) => Promise<boolean>;
} = {}): IsolationGuardContext {
  const lookup = overrides.chains ?? chains;
  const runtime = {
    db: {
      getSessionCallerChain: vi.fn(async (sessionId: string) => {
        const value = lookup[sessionId];
        if (value instanceof Error) throw value;
        if (!value) return { root: null, ancestors: [] };
        return value;
      }),
    },
    worktreeService: {
      ownsWorktree: overrides.ownsWorktree ?? (async () => false),
    },
  } as unknown as McpRuntime;
  return { runtime, principal: { tier: "restricted", sessionId: ME } };
}

describe("message-recipient guard", () => {
  it("allows self without touching the caller chain", async () => {
    const ctx = context();
    const decision = await runIsolationToolGuard(
      "message-recipient",
      { target_session_id: ME, message: "hi" },
      ctx,
    );
    expect(decision.ok).toBe(true);
    expect(ctx.runtime.db.getSessionCallerChain).not.toHaveBeenCalled();
  });

  it("allows an ancestor recipient", async () => {
    const decision = await runIsolationToolGuard(
      "message-recipient",
      { target_session_id: PARENT },
      context(),
    );
    expect(decision.ok).toBe(true);
  });

  it("allows a descendant recipient", async () => {
    const decision = await runIsolationToolGuard(
      "message-recipient",
      { target_session_id: CHILD },
      context(),
    );
    expect(decision.ok).toBe(true);
  });

  it("denies an unrelated recipient with MCP_POLICY_DENIED", async () => {
    const decision = await runIsolationToolGuard(
      "message-recipient",
      { target_session_id: OTHER },
      context(),
    );
    expect(decision).toEqual({ ok: false, message: "MCP_POLICY_DENIED: message-recipient" });
  });

  it.each([
    ["missing recipient", {}],
    ["non-string recipient", { target_session_id: 42 }],
    ["empty recipient", { target_session_id: "" }],
  ])("denies %s", async (_label, args) => {
    const decision = await runIsolationToolGuard("message-recipient", args, context());
    expect(decision.ok).toBe(false);
  });

  it.each([
    ["cycle", { root: row(ME, PARENT), ancestors: [row(PARENT, ME)] }],
    ["broken chain", { root: row(ME, PARENT), ancestors: [] }],
    ["trailing rows", { root: row(ME, PARENT), ancestors: [row(PARENT, null), row(GRAND, null)] }],
    ["missing root", { root: null, ancestors: [] }],
    ["lookup failure", new Error("db down")],
  ])("denies when the caller chain is unprovable (%s)", async (_label, chain) => {
    const ctx = context({ chains: { [ME]: chain as SessionExecutionChain | Error, [OTHER]: chains[OTHER] } });
    const decision = await runIsolationToolGuard(
      "message-recipient",
      { target_session_id: OTHER },
      ctx,
    );
    expect(decision.ok).toBe(false);
  });
});

describe("argument-shaping guards", () => {
  it("draft-card rejects run and queue requests", async () => {
    await expect(runIsolationToolGuard("draft-card", { run: true }, context()))
      .resolves.toEqual({ ok: false, message: "MCP_POLICY_DENIED: draft-card" });
    await expect(runIsolationToolGuard("draft-card", { queue: true }, context()))
      .resolves.toEqual({ ok: false, message: "MCP_POLICY_DENIED: draft-card" });
    await expect(runIsolationToolGuard("draft-card", { title: "draft" }, context()))
      .resolves.toEqual({ ok: true, args: { title: "draft" } });
  });

  it("card-status rejects queued and running", async () => {
    for (const status of ["queued", "running"]) {
      await expect(runIsolationToolGuard("card-status", { status }, context()))
        .resolves.toEqual({ ok: false, message: "MCP_POLICY_DENIED: card-status" });
    }
    await expect(runIsolationToolGuard("card-status", { status: "done" }, context()))
      .resolves.toEqual({ ok: true, args: { status: "done" } });
  });

  it("worktree-create rejects adopt, shared setup and require_setup and forces setup=none", async () => {
    for (const args of [
      { mode: "adopt", adopt_path: "/tmp/x", expected_head: "abc" },
      { mode: "new", adopt_path: "/tmp/x" },
      { mode: "new", setup: "shared_dependencies" },
      { mode: "new", require_setup: true },
    ]) {
      await expect(runIsolationToolGuard("worktree-create", args, context()))
        .resolves.toEqual({ ok: false, message: "MCP_POLICY_DENIED: worktree-create" });
    }
    await expect(runIsolationToolGuard("worktree-create", { repo_id: "r", branch: "b", mode: "new" }, context()))
      .resolves.toEqual({ ok: true, args: { repo_id: "r", branch: "b", mode: "new", setup: "none", require_setup: false } });
  });

  it("create-local-session forces the authenticated caller session id", async () => {
    const decision = await runIsolationToolGuard(
      "create-local-session",
      { caller_session_id: OTHER, agent_id: "roselin" },
      context(),
    );
    expect(decision).toEqual({ ok: true, args: { caller_session_id: ME, agent_id: "roselin" } });
  });
});

describe("owned-worktree guard", () => {
  it("allows only when createdBySessionId matches the authenticated session", async () => {
    const owned = context({ ownsWorktree: async () => true });
    await expect(runIsolationToolGuard("owned-worktree", { worktree_id: "wt-1" }, owned))
      .resolves.toEqual({ ok: true, args: { worktree_id: "wt-1" } });

    const foreign = context({ ownsWorktree: async () => false });
    await expect(runIsolationToolGuard("owned-worktree", { worktree_id: "wt-1" }, foreign))
      .resolves.toEqual({ ok: false, message: "MCP_POLICY_DENIED: owned-worktree" });
  });

  it("denies missing ids, missing service and ownership lookup failures", async () => {
    await expect(runIsolationToolGuard("owned-worktree", {}, context()))
      .resolves.toEqual({ ok: false, message: "MCP_POLICY_DENIED: owned-worktree" });

    const throwing = context({ ownsWorktree: async () => { throw new Error("db down"); } });
    await expect(runIsolationToolGuard("owned-worktree", { worktree_id: "wt-1" }, throwing))
      .resolves.toEqual({ ok: false, message: "MCP_POLICY_DENIED: owned-worktree" });

    const noService = { runtime: { db: {} } as unknown as McpRuntime, principal: { tier: "restricted" as const, sessionId: ME } };
    await expect(runIsolationToolGuard("owned-worktree", { worktree_id: "wt-1" }, noService))
      .resolves.toEqual({ ok: false, message: "MCP_POLICY_DENIED: owned-worktree" });
  });
});

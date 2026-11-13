import { describe, expect, it } from "vitest";

import { reconcileNodeStartup } from "../src/control_plane/repositories/node_startup_reconciliation.js";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";

/**
 * Ingress gate (event_session_gate.ts) and the SQL functions lock the session
 * row first and the worktree row second. Startup reconciliation must take the
 * same order, otherwise the two paths can deadlock on one session and worktree.
 */
function recordStatements(): { sql: SqlClient; statements: string[] } {
  const statements: string[] = [];
  const query = async (strings: TemplateStringsArray) => {
    statements.push(strings.join("?").replace(/\s+/g, " ").trim());
    return [];
  };
  const sql = Object.assign(query, {
    begin: async (callback: (tx: unknown) => Promise<unknown>) => await callback(sql),
    json: (value: unknown) => value,
    array: (value: unknown) => value,
  });
  return { sql: sql as unknown as SqlClient, statements };
}

describe("node startup reconciliation lock order", () => {
  it("locks restorable sessions by session_id before worktrees by id", async () => {
    const { sql, statements } = recordStatements();
    await reconcileNodeStartup(sql, "node-1", ["s2", "s1"], new Date(0));

    const sessionLock = statements.findIndex((text) =>
      /FROM sessions\b/.test(text) && /ORDER BY session_id\b/.test(text) && /FOR UPDATE/.test(text)
    );
    const worktreeLock = statements.findIndex((text) =>
      /FROM worktrees\b/.test(text) && /FOR UPDATE/.test(text)
    );
    expect(sessionLock).toBeGreaterThanOrEqual(0);
    expect(worktreeLock).toBeGreaterThanOrEqual(0);
    expect(sessionLock).toBeLessThan(worktreeLock);
    expect(statements[worktreeLock]).toMatch(/ORDER BY id\b[^;]*FOR UPDATE/);
  });
});

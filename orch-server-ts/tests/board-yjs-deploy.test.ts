import { describe, expect, it } from "vitest";

import {
  decideBoardYjsRunbookDeployAction,
  runBoardYjsRunbookDeployment,
} from
  "../src/board-yjs/board_yjs_runbook_deploy.js";

describe("board Y.Doc runbook deployment node guard", () => {
  it("skips without a child command on non-central nodes", () => {
    expect(decideBoardYjsRunbookDeployAction({
      nodeId: "eias-linegames",
      mode: "migrate",
      approvedCollisionHashCount: 18,
    })).toEqual({ action: "skip", reason: "non_central_node" });
  });

  it("runs the migration on eiaserinnys after collision approval", () => {
    expect(decideBoardYjsRunbookDeployAction({
      nodeId: "eiaserinnys",
      mode: "migrate",
      approvedCollisionHashCount: 18,
    })).toEqual({ action: "run", reason: "approved" });
  });

  it("keeps an approval-pending rollout read-only", () => {
    expect(decideBoardYjsRunbookDeployAction({
      nodeId: "eiaserinnys",
      mode: "migrate",
      approvedCollisionHashCount: 0,
    })).toEqual({ action: "report", reason: "approval_pending" });
  });

  it("runs strict verification only after approval", () => {
    expect(decideBoardYjsRunbookDeployAction({
      nodeId: "eiaserinnys",
      mode: "verify",
      approvedCollisionHashCount: 18,
    })).toEqual({ action: "run", reason: "approved" });
    expect(decideBoardYjsRunbookDeployAction({
      nodeId: "eiaserinnys",
      mode: "verify",
      approvedCollisionHashCount: 0,
    })).toEqual({ action: "report", reason: "approval_pending" });
  });

  it("never invokes a migration child command on non-central nodes", async () => {
    const events: string[] = [];
    await runBoardYjsRunbookDeployment({
      nodeId: "eias-linegames-wsl",
      mode: "migrate",
      approvedCollisionHashCount: 18,
      applySqlMigrations: async () => events.push("sql"),
      reportResidue: async () => events.push("report"),
      applyResidueMigration: async () => events.push("apply"),
      verifyResidue: async () => events.push("verify"),
      audit: async (status) => events.push(`audit:${status}`),
    });
    expect(events).toEqual(["audit:skipped"]);
  });

  it("runs SQL then Y.Doc migration on the central node", async () => {
    const events: string[] = [];
    await runBoardYjsRunbookDeployment({
      nodeId: "eiaserinnys",
      mode: "migrate",
      approvedCollisionHashCount: 18,
      applySqlMigrations: async () => events.push("sql"),
      reportResidue: async () => events.push("report"),
      applyResidueMigration: async () => events.push("apply"),
      verifyResidue: async () => events.push("verify"),
      audit: async (status) => events.push(`audit:${status}`),
    });
    expect(events).toEqual(["sql", "apply", "audit:applied"]);
  });

  it("reports residue without applying it while approval is empty", async () => {
    const events: string[] = [];
    await runBoardYjsRunbookDeployment({
      nodeId: "eiaserinnys",
      mode: "migrate",
      approvedCollisionHashCount: 0,
      applySqlMigrations: async () => events.push("sql"),
      reportResidue: async () => events.push("report"),
      applyResidueMigration: async () => events.push("apply"),
      verifyResidue: async () => events.push("verify"),
      audit: async (status) => events.push(`audit:${status}`),
    });
    expect(events).toEqual(["sql", "report", "audit:approval_pending"]);
  });
});

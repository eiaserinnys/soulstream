import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  decideBoardYjsRunbookDeployAction,
  runBoardYjsRunbookDeployment,
} from
  "../src/board-yjs/board_yjs_runbook_deploy.js";

describe("board Y.Doc runbook deployment", () => {
  it("selects the apply path from the committed approval file", () => {
    const approvals = JSON.parse(readFileSync(
      new URL("../scripts/ydoc-runbook-collision-approvals.json", import.meta.url),
      "utf8",
    )) as string[];

    expect(approvals).toHaveLength(18);
    expect(new Set(approvals).size).toBe(18);
    expect(decideBoardYjsRunbookDeployAction({
      mode: "migrate",
      approvedCollisionHashCount: approvals.length,
    })).toEqual({ action: "run", reason: "approved" });
  });

  it("runs the residue subphase after collision approval", () => {
    expect(decideBoardYjsRunbookDeployAction({
      mode: "migrate",
      approvedCollisionHashCount: 18,
    })).toEqual({ action: "run", reason: "approved" });
  });

  it("keeps an approval-pending rollout read-only", () => {
    expect(decideBoardYjsRunbookDeployAction({
      mode: "migrate",
      approvedCollisionHashCount: 0,
    })).toEqual({ action: "report", reason: "approval_pending" });
  });

  it("runs strict verification only after approval", () => {
    expect(decideBoardYjsRunbookDeployAction({
      mode: "verify",
      approvedCollisionHashCount: 18,
    })).toEqual({ action: "run", reason: "approved" });
    expect(decideBoardYjsRunbookDeployAction({
      mode: "verify",
      approvedCollisionHashCount: 0,
    })).toEqual({ action: "report", reason: "approval_pending" });
  });

  it("always applies SQL before the residue subphase", async () => {
    const events: string[] = [];
    await runBoardYjsRunbookDeployment({
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

  it("runs SQL then Y.Doc migration on the central node", async () => {
    const events: string[] = [];
    await runBoardYjsRunbookDeployment({
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

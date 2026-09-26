export const BOARD_YJS_RUNBOOK_COLLISION_APPROVAL_COUNT = 18;

export type BoardYjsRunbookDeployMode = "migrate" | "verify";

export function decideBoardYjsRunbookDeployAction(input: {
  mode: BoardYjsRunbookDeployMode;
  approvedCollisionHashCount: number;
}):
  | { action: "report"; reason: "approval_pending" }
  | { action: "run"; reason: "approved" } {
  if (input.approvedCollisionHashCount === 0) {
    return { action: "report", reason: "approval_pending" };
  }
  if (input.approvedCollisionHashCount !== BOARD_YJS_RUNBOOK_COLLISION_APPROVAL_COUNT) {
    throw new Error(
      `collision approval file must contain either 0 or ` +
        `${BOARD_YJS_RUNBOOK_COLLISION_APPROVAL_COUNT} hashes`,
    );
  }
  return { action: "run", reason: "approved" };
}

export async function runBoardYjsRunbookDeployment(input: {
  mode: BoardYjsRunbookDeployMode;
  approvedCollisionHashCount: number;
  applySqlMigrations: () => Promise<unknown>;
  reportResidue: () => Promise<unknown>;
  applyResidueMigration: () => Promise<unknown>;
  verifyResidue: () => Promise<unknown>;
  audit: (status: "approval_pending" | "applied" | "verified") =>
    Promise<unknown>;
}): Promise<void> {
  if (input.mode === "migrate") await input.applySqlMigrations();
  const decision = decideBoardYjsRunbookDeployAction(input);
  if (decision.action === "report") {
    await input.reportResidue();
    await input.audit("approval_pending");
    return;
  }
  if (input.mode === "migrate") {
    await input.applyResidueMigration();
    await input.audit("applied");
    return;
  }
  await input.verifyResidue();
  await input.audit("verified");
}

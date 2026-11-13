import { describe, expect, it } from "vitest";

import { generateNodeStateDocument } from "../../../src/task/state/node_charts.js";
import {
  INSTRUCTION_UNCERTAIN_REASON,
  NODE_INSTRUCTION_LEDGERS,
  NODE_INSTRUCTION_VERDICTS,
  decideNodeInstruction,
  instructionNumberOf,
  nodeInstructionRows,
  withInstructionNumber,
} from "../../../src/task/state/node_instruction_decision.js";

describe("node instruction decision", () => {
  it("never resends an unknown answer and leaves it uncertain when a ledger line exists", () => {
    expect(decideNodeInstruction({ verdict: "unknown", ledger: "line" })).toEqual({
      resend: false,
      ledger: "mark_uncertain",
    });
    expect(decideNodeInstruction({ verdict: "unknown", ledger: "none" })).toEqual({
      resend: false,
      ledger: "warn_only",
    });
  });

  it("does not resend an applied instruction and closes its ledger line as consumed", () => {
    expect(decideNodeInstruction({ verdict: "applied", ledger: "line" })).toEqual({
      resend: false,
      ledger: "close_consumed",
    });
    expect(decideNodeInstruction({ verdict: "applied", ledger: "none" }).resend).toBe(false);
  });

  it("resends only a certainly-not-applied instruction", () => {
    for (const ledger of NODE_INSTRUCTION_LEDGERS) {
      expect(decideNodeInstruction({ verdict: "not_applied", ledger }).resend).toBe(true);
    }
    const resending = NODE_INSTRUCTION_VERDICTS.filter((verdict) =>
      decideNodeInstruction({ verdict, ledger: "line" }).resend);
    expect(resending).toEqual(["not_applied"]);
  });

  it("has a row for every answer and ledger combination, and the document carries the table", () => {
    const rows = nodeInstructionRows();
    expect(rows).toHaveLength(NODE_INSTRUCTION_VERDICTS.length * NODE_INSTRUCTION_LEDGERS.length);
    const document = generateNodeStateDocument().markdown;
    expect(document).toContain("## 결과를 모르는 지시");
    expect(document).toContain(INSTRUCTION_UNCERTAIN_REASON);
    for (const row of rows) {
      expect(document).toContain(`| ${row.verdict} | ${row.ledger} | ${row.resend} | ${row.action} |`);
    }
  });

  it("numbers an instruction by its runner number, then its ledger id, and fills one only when neither exists", () => {
    expect(instructionNumberOf({ runnerInterventionId: "r", deliveryId: "d" })).toBe("r");
    expect(instructionNumberOf({ deliveryId: "d" })).toBe("d");
    expect(instructionNumberOf({})).toBeUndefined();

    const withLedger = { deliveryId: "d" };
    expect(withInstructionNumber(withLedger, () => "new")).toBe(withLedger);
    const bare = { text: "x" };
    const filled = withInstructionNumber(bare, () => "new");
    expect(filled).toEqual({ text: "x", runnerInterventionId: "new" });
    expect(bare).toEqual({ text: "x" });
  });
});

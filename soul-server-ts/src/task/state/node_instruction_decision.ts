/**
 * 러너에 넘긴 지시의 결과를 모를 때 번호로 물은 답을 가르는 정본이다.
 * 러너가 받은 지시 번호를 기록하고(카드 #1265) 노드가 번호로 묻는다(카드 #1266 지시 경로).
 * 이 파일은 순수 함수만 둔다. 러너에 묻는 일과 장부에 쓰는 일은 호출자가 한다.
 */

/**
 * 러너가 번호로 묻는 말에 답한 결과다.
 * 같은 등록의 러너가 받은 적 없다고 답한 경우만 `not_applied`다.
 * 러너 없음, 등록이 바뀜, 조회 실패, 옛 러너의 모르는 명령 응답, 넘기던 참의 줄은 모두 `unknown`이다.
 * 문자열은 `runner/runner_intervention_receipt.ts`의 판정과 같다. task/state는 runner를 import하지 않는다.
 */
export type NodeInstructionVerdict = "applied" | "not_applied" | "unknown";

export const NODE_INSTRUCTION_VERDICTS: readonly NodeInstructionVerdict[] = [
  "applied",
  "not_applied",
  "unknown",
];

/** 장부 줄이 없는 지시는 영속 상태가 없다. */
export type NodeInstructionLedger = "line" | "none";

export const NODE_INSTRUCTION_LEDGERS: readonly NodeInstructionLedger[] = ["line", "none"];

/** 판정이 장부에 시키는 일이다. */
export type NodeInstructionLedgerAction =
  | "close_consumed"
  | "keep_state"
  | "mark_uncertain"
  | "warn_only";

export interface NodeInstructionFacts {
  verdict: NodeInstructionVerdict;
  ledger: NodeInstructionLedger;
}

export interface NodeInstructionDecision {
  /** 같은 지시를 러너나 큐로 다시 보내는가. 모름은 절대 보내지 않는다. */
  resend: boolean;
  ledger: NodeInstructionLedgerAction;
}

/** 모름으로 닫힌 장부 줄의 사유 문구다. 재시작 뒤에도 남아 사람이 본다. */
export const INSTRUCTION_UNCERTAIN_REASON = "runner_receipt_unknown";

/**
 * 결과를 모르는 지시를 번호로 물은 답에 따라 가른다.
 * - 적용됨: 다시 보내지 않고 장부를 소비로 닫는다.
 * - 확실히 안 됨: 다시 보낸다. 장부는 건드리지 않고 다시 보내는 길이 이어 쓴다.
 * - 모름: 자동으로 다시 보내지 않는다. 장부 줄은 uncertain으로 남기고 줄이 없으면 경고 기록만 남긴다.
 */
export function decideNodeInstruction(facts: NodeInstructionFacts): NodeInstructionDecision {
  switch (facts.verdict) {
    case "applied":
      return {
        resend: false,
        ledger: facts.ledger === "line" ? "close_consumed" : "keep_state",
      };
    case "not_applied":
      return { resend: true, ledger: "keep_state" };
    case "unknown":
      return {
        resend: false,
        ledger: facts.ledger === "line" ? "mark_uncertain" : "warn_only",
      };
  }
}

/**
 * 러너에 넘기는 모든 지시가 싣는 번호다. 장부 줄이 있으면 장부 번호가 곧 번호이고,
 * 없으면 넘기기 전에 정해 지시 메시지에 남긴 번호를 쓴다. 둘 다 없으면 물을 수 없다.
 */
export function instructionNumberOf(message: {
  runnerInterventionId?: string;
  deliveryId?: string;
}): string | undefined {
  return message.runnerInterventionId ?? message.deliveryId;
}

/**
 * 번호가 없는 지시에 번호를 채워 돌려준다. 번호가 있으면 같은 객체를 돌려준다.
 * 새 번호는 호출자가 넘기기 전에 정해 메시지에 남기므로 큐를 거쳐 다음 실행에도 같은 번호가 실린다.
 */
export function withInstructionNumber<
  T extends { runnerInterventionId?: string; deliveryId?: string },
>(message: T, newNumber: () => string): T {
  return instructionNumberOf(message) === undefined
    ? { ...message, runnerInterventionId: newNumber() }
    : message;
}

export const NODE_INSTRUCTION_VERDICT_LABELS: Readonly<Record<NodeInstructionVerdict, string>> = {
  applied: "적용됨(엔진이 입력을 받음)",
  not_applied: "확실히 안 됨(같은 등록의 러너가 받은 적 없다고 답함)",
  unknown: "모름(러너 없음, 등록이 바뀜, 조회 실패, 옛 러너의 모르는 명령, 넘기던 참)",
};

export const NODE_INSTRUCTION_LEDGER_LABELS: Readonly<Record<NodeInstructionLedger, string>> = {
  line: "장부 줄 있음",
  none: "장부 줄 없음",
};

export const NODE_INSTRUCTION_ACTION_LABELS: Readonly<Record<NodeInstructionLedgerAction, string>> = {
  close_consumed: "소비로 닫음",
  keep_state: "장부는 그대로",
  mark_uncertain: `uncertain으로 남김(${INSTRUCTION_UNCERTAIN_REASON})`,
  warn_only: "경고 기록만 남김",
};

export interface NodeInstructionRow {
  verdict: string;
  ledger: string;
  resend: string;
  action: string;
}

/** 번호로 물은 결과를 가르는 표다. 모든 답과 장부 유무 조합에 처분이 있다. */
export function nodeInstructionRows(): NodeInstructionRow[] {
  const rows: NodeInstructionRow[] = [];
  for (const verdict of NODE_INSTRUCTION_VERDICTS) {
    for (const ledger of NODE_INSTRUCTION_LEDGERS) {
      const decision = decideNodeInstruction({ verdict, ledger });
      rows.push({
        verdict: NODE_INSTRUCTION_VERDICT_LABELS[verdict],
        ledger: NODE_INSTRUCTION_LEDGER_LABELS[ledger],
        resend: decision.resend ? "다시 보냄" : "다시 보내지 않음",
        action: NODE_INSTRUCTION_ACTION_LABELS[decision.ledger],
      });
    }
  }
  return rows;
}

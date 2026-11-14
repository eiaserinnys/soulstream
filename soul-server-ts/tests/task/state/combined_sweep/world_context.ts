/**
 * 합친 훑기 세계의 공용 문맥이다: 선택지, 걸음 셈, 노드 실행 상태 투영, 넘긴 지시의 처분(카드 #1266 U5c).
 */
import type { NodeExecutionFacts, NodeExecutionPhase } from "../../../../src/task/state/node_execution_machine.js";
import type { NodeResponseCall } from "../../../../src/task/state/node_response_machine.js";
import type { ProductDecisions } from "./product_decisions.js";
import { keyOf, type G, type Instruction, type NodeExec } from "./world_state.js";

export interface WorldOptions {
  /** 통로 하나의 길이(M:39 K). */
  k: number;
  /** 통로 둘의 길이(M:40 K2). */
  k2: number;
  /** 참이면 재시작 때 메모리 대기 줄을 장부로 되찾지 못한다(M:41 CODEX). 셋째 판 숫자는 참으로 쟀다. */
  codex: boolean;
  /** 끌 걸음 번호(M:42 ENV_OFF). */
  envOff: ReadonlySet<string>;
  /** I3 완료 정산 미결의 영속(M:315-320). 판정이 completion_settlement_sweeper.ts에 있어 세계 스위치다. */
  settlePending: boolean;
  /** I6 코덱스 대기 지시 복구(M:245-251). 장부 다시 잇기가 순수 함수 밖에 있어 세계 스위치다. */
  requeue: boolean;
  decisions: ProductDecisions;
}

/** 걸음이 세는 것이다(M:113-116). 키는 구성 키, 필요하면 걸음 번호를 붙인다. */
export interface StepCounters {
  dupHandover: Set<string>;
  vanishedStop: Set<string>;
  republishedEnd: Set<string>;
  heldTaken: Set<string>;
}

export function newCounters(): StepCounters {
  return { dupHandover: new Set(), vanishedStop: new Set(), republishedEnd: new Set(), heldTaken: new Set() };
}

export interface WorldContext {
  options: WorldOptions;
  counters: StepCounters;
  emit(g: G, msg: string, changes?: Partial<G>): G[];
  /** 넘기던 지시의 결과를 번호로 물어 처분한다(M:151-158). */
  loseHandover(g: G, eventId: string, src?: G): Instruction;
  phase(g: G): NodeExecutionPhase;
}

const ACTIVE_EXEC = new Set<NodeExec>(["gate", "resume_w", "reg_w", "turn", "stopping", "replay", "adopt_w"]);

/**
 * 구성을 노드 실행 상태 투영의 입력으로 옮긴다. 모형에 없는 Task 필드는 고정값이다
 * (해제 청구 없음, DB에서 올린 task 아님).
 */
export function nodeExecutionFactsOf(g: G, codex: boolean): NodeExecutionFacts {
  const active = ACTIVE_EXEC.has(g.ex);
  const learnedEnd = g.ex === "replay";
  return {
    active,
    terminalRecorded: !active && (g.ex === "fin1" || g.ex === "fin2" || g.life === "held"),
    hasRunner: g.p !== "none",
    offlineReplay: g.ex === "replay" && g.p === "dead",
    hasStartBarrier: g.ex === "gate" || g.ex === "resume_w",
    // 잇기 대기는 등록을 다시 세우는 중이라 등록이 없는 것으로 본다.
    hasRegistration: g.ex === "turn" || g.ex === "stopping" || g.ex === "replay",
    runnerTerminalFact: !learnedEnd
      ? "none"
      : g.life === "ended" || g.life === "ended_l"
        ? "completed"
        : g.life === "reaped" ? "reaped" : "none",
    retention: g.life === "held" ? (codex ? "codex_command" : "claude_background") : "none",
    releasing: false,
    hydratedFromDb: false,
    stopRequested: g.ex === "stopping",
  };
}

/** 노드가 기다리는 응답의 호출 종류다. 잇기는 시동 복구와 붙은 러너가 같은 칸을 낸다(시험이 확인한다). */
export const RESPONSE_CALL: Readonly<Partial<Record<NodeExec, NodeResponseCall>>> = {
  resume_w: "resume",
  reg_w: "execution_registration",
  adopt_w: "startup_recovery_adopt",
  end_w: "termination",
  copy_w: "resume_compensation_terminal",
};

export function createContext(options: WorldOptions, counters: StepCounters): WorldContext {
  const { decisions } = options;
  return {
    options,
    counters,
    emit(g, msg, changes = {}) {
      if (g.ch.length >= options.k) return [];
      return [{ ...g, ch: [...g.ch, msg], ...changes }];
    },
    loseHandover(g, eventId, src) {
      if (g.q !== "handing") return g.q;
      // 같은 등록의 러너가 살아 있으면 받은 지시 번호로 답한다. 답이 줄에 있으면 적용됨이다.
      const verdict = g.u2.includes("H_OK") ? "applied" : "not_applied";
      const decision = decisions.nodeInstruction({ verdict, ledger: "line" });
      if (decision.resend) {
        if (verdict === "applied") counters.dupHandover.add(`${keyOf(src ?? g)}#${eventId}`);
        return "waiting";
      }
      if (verdict === "applied") return "empty";
      throw new Error(`unmapped instruction decision: ${verdict} ${JSON.stringify(decision)}`);
    },
    phase(g) {
      return decisions.nodePhase(nodeExecutionFactsOf(g, options.codex));
    },
  };
}

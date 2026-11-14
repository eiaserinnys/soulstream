/**
 * 합친 훑기가 부르는 제품 판정 함수 묶음, 입력 키 캐시, 되돌림 시험의 덮개다(카드 #1266 U5c).
 * 판정 함수는 바꾸지 않고 그대로 부른다. 덮개는 시험 전용이고 옛 동작을 낸다.
 */
import { decideNodeStopRequest, stepNodeBarrier, type NodeBarrierStep } from "../../../../src/task/state/node_barrier_decision.js";
import type { NodeBarrierEventType, NodeBarrierState, NodeStopDisposition } from "../../../../src/task/state/node_barrier_machine.js";
import { projectNodeExecutionPhase } from "../../../../src/task/state/node_execution_decision.js";
import type { NodeExecutionFacts, NodeExecutionPhase } from "../../../../src/task/state/node_execution_machine.js";
import {
  decideNodeInstruction,
  type NodeInstructionDecision,
  type NodeInstructionFacts,
} from "../../../../src/task/state/node_instruction_decision.js";
import { decideNodeRequest } from "../../../../src/task/state/node_request_decision.js";
import type { NodeRequestDisposition, NodeRequestKind } from "../../../../src/task/state/node_request_machine.js";
import { decideNodeResponse, type NodeResponseDecision } from "../../../../src/task/state/node_response_decision.js";
import type { NodeResponseFacts } from "../../../../src/task/state/node_response_machine.js";
import { decideRunnerCentralCheck } from "../../../../src/runner/state/runner_central_check_decision.js";
import type { RunnerCentralCheckDecision, RunnerCentralCheckFacts } from "../../../../src/runner/state/runner_central_check_machine.js";
import { decideRunnerHandle } from "../../../../src/runner/state/runner_handle_decision.js";
import type { RunnerHandleAction, RunnerHandleFacts } from "../../../../src/runner/state/runner_handle_machine.js";
import { decideRunnerLifecycleStep } from "../../../../src/runner/state/runner_lifecycle_decision.js";
import type {
  RunnerLifecycleDecision,
  RunnerLifecycleState,
  RunnerLifecycleStep,
} from "../../../../src/runner/state/runner_lifecycle_machine.js";
import { decideRunnerRecovery } from "../../../../src/runner/state/runner_recovery_decision.js";
import type { RunnerRecoveryDisposition, RunnerRecoveryFacts } from "../../../../src/runner/state/runner_recovery_machine.js";

export interface ProductDecisions {
  nodePhase(facts: NodeExecutionFacts): NodeExecutionPhase;
  nodeRequest(phase: NodeExecutionPhase, request: NodeRequestKind): NodeRequestDisposition;
  /** null은 덮개가 내는 옛 동작이다: 멈춤이 처분 없이 사라진다. */
  nodeStopRequest(preceding: NodeBarrierState): NodeStopDisposition | null;
  nodeBarrier(state: NodeBarrierState, event: NodeBarrierEventType): NodeBarrierStep;
  nodeResponse(facts: NodeResponseFacts): NodeResponseDecision;
  /** 결과를 모르는 지시를 번호로 물은 답의 처분이다(I4 고침). */
  nodeInstruction(facts: NodeInstructionFacts): NodeInstructionDecision;
  /** 러너가 넘기기에 곧바로 답한 결과의 처분이다. 같은 제품 함수이고, 덮개는 이것을 바꾸지 않는다. */
  nodeInstructionReply(facts: NodeInstructionFacts): NodeInstructionDecision;
  runnerRecovery(facts: RunnerRecoveryFacts): RunnerRecoveryDisposition;
  runnerHandle(facts: RunnerHandleFacts): RunnerHandleAction;
  runnerCentralCheck(facts: RunnerCentralCheckFacts): RunnerCentralCheckDecision;
  runnerLifecycle(state: RunnerLifecycleState, step: RunnerLifecycleStep, commandMatches: boolean): RunnerLifecycleDecision;
}

export type DecisionName = keyof ProductDecisions;

/** 제품 판정 함수 그대로다. */
export const PRODUCT: ProductDecisions = {
  nodePhase: projectNodeExecutionPhase,
  nodeRequest: decideNodeRequest,
  nodeStopRequest: decideNodeStopRequest,
  nodeBarrier: stepNodeBarrier,
  nodeResponse: decideNodeResponse,
  nodeInstruction: decideNodeInstruction,
  nodeInstructionReply: decideNodeInstruction,
  runnerRecovery: decideRunnerRecovery,
  runnerHandle: decideRunnerHandle,
  runnerCentralCheck: decideRunnerCentralCheck,
  runnerLifecycle: decideRunnerLifecycleStep,
};

export interface CacheEntry {
  name: DecisionName;
  args: unknown[];
  result: unknown;
}

export interface CachedDecisions {
  decisions: ProductDecisions;
  /** 캐시에 든 입력과 출력이다. */
  entries(): CacheEntry[];
  /** 판정 이름별로 실제로 부른 횟수와 캐시가 받은 횟수다. */
  stats(): Record<string, { calls: number; misses: number }>;
}

/**
 * 입력 키 캐시다. 판정 함수는 순수하므로 같은 입력이면 같은 출력을 돌려준다.
 * 결과 객체는 얼려서 걸음이 고치지 못하게 한다.
 */
export function withCache(inner: ProductDecisions): CachedDecisions {
  const tables = new Map<DecisionName, Map<string, CacheEntry>>();
  const counts: Record<string, { calls: number; misses: number }> = {};
  const wrap = <K extends DecisionName>(name: K): ProductDecisions[K] => {
    const table = new Map<string, CacheEntry>();
    tables.set(name, table);
    counts[name] = { calls: 0, misses: 0 };
    const fn = inner[name] as (...args: unknown[]) => unknown;
    return ((...args: unknown[]) => {
      const key = JSON.stringify(args);
      const count = counts[name]!;
      count.calls += 1;
      const hit = table.get(key);
      if (hit) return hit.result;
      count.misses += 1;
      const result = deepFreeze(fn(...args));
      table.set(key, { name, args: structuredClone(args), result });
      return result;
    }) as ProductDecisions[K];
  };
  const decisions = Object.fromEntries(
    (Object.keys(inner) as DecisionName[]).map((name) => [name, wrap(name)]),
  ) as unknown as ProductDecisions;
  return {
    decisions,
    entries: () => [...tables.values()].flatMap((table) => [...table.values()]),
    stats: () => structuredClone(counts),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const RUNNER_BEARING = new Set(["execution_registration", "startup_recovery_adopt", "attached_runner_adopt"]);

/**
 * 되돌림 시험의 덮개다. 노드 쪽 고침 하나를 옛 동작으로 바꿔 끼운다.
 * 판정이 순수 함수 밖에 있는 고침(I3 완료 정산 미결, I6 코덱스 대기 지시 복구)은 세계의 스위치로 만든다.
 */
export const REVERT_OVERLAYS = {
  /** I2 영구 거절 칸: dead letter도 적용 안 됨 하나로 뭉쳐 다시 될 수 있는 거절로 읽는다. */
  dlcell: (inner: ProductDecisions): ProductDecisions => ({
    ...inner,
    nodeResponse: (facts) =>
      facts.route === "dead_letter"
        ? {
          cell: "retryable",
          reason: null,
          intents: [facts.call === "termination" ? "resubmit_same_termination" : "retry_later"],
        }
        : inner.nodeResponse(facts),
  }),
  /** I4 거절 사유를 받은 거둠: 러너를 든 호출의 거절 사유를 보지 않고 다시 될 수 있는 거절로 읽는다. */
  reap: (inner: ProductDecisions): ProductDecisions => ({
    ...inner,
    nodeResponse: (facts) =>
      RUNNER_BEARING.has(facts.call) && facts.route === "applied_false"
        ? { cell: "retryable", reason: null, intents: ["retry_later"] }
        : inner.nodeResponse(facts),
  }),
  /** I4 넘긴 지시를 번호로 물음: 묻지 않고 늘 다시 보낸다. */
  handover: (inner: ProductDecisions): ProductDecisions => ({
    ...inner,
    nodeInstruction: () => ({ resend: true, ledger: "keep_state" }),
  }),
  /** 후보 라 넘기는 중 멈춤: 넘기기 장벽 앞의 멈춤이 처분 없이 사라진다. */
  stop: (inner: ProductDecisions): ProductDecisions => ({
    ...inner,
    nodeStopRequest: (preceding) =>
      preceding === "intervention_handoff" ? null : inner.nodeStopRequest(preceding),
  }),
} as const satisfies Record<string, (inner: ProductDecisions) => ProductDecisions>;

export type RevertOverlay = keyof typeof REVERT_OVERLAYS;

/**
 * 모형 대조 덮개다. 되돌림이 아니다. 잇기가 워크트리 점유(worktree_busy)로 거절되면 M처럼
 * 러너를 거두고 오류 종료를 올린다(M:408-412). 제품은 이 거절을 다시 될 수 있는 거절로 두고
 * 거두지 않는다(node_adopt_rejection.ts, design.md:42). 이 칸 하나만 바꾸면 세계가 M의 숫자를 그대로 내는지 본다.
 */
export function modelWorktreeBusyReap(inner: ProductDecisions): ProductDecisions {
  return {
    ...inner,
    nodeResponse: (facts) =>
      (facts.call === "startup_recovery_adopt" || facts.call === "attached_runner_adopt")
      && facts.route === "applied_false"
      && facts.reason === "worktree_busy"
        ? { cell: "no_retry", reason: "worktree_busy", intents: ["mark_central_error", "reap_runner"] }
        : inner.nodeResponse(facts),
  };
}

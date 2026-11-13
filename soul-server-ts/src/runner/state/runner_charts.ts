import { toMermaid, type ChartSpec } from "@soulstream/statechart";

import { decideRunnerCentralCheck } from "./runner_central_check_decision.js";
import {
  RUNNER_ADOPT_RESPONSES,
  RUNNER_CENTRAL_CHECK_DECISIONS,
  RUNNER_CENTRAL_LOOKUPS,
  runnerCentralCheckMachine,
  type RunnerAdoptResponse,
  type RunnerCentralCheckDecision,
  type RunnerCentralLookup,
} from "./runner_central_check_machine.js";
import { decideRunnerHandle } from "./runner_handle_decision.js";
import {
  RUNNER_HANDLE_ACTIONS,
  RUNNER_HANDLE_ATTACHED_TERMINAL_STATES,
  RUNNER_HANDLE_BACKGROUND_STATES,
  RUNNER_HANDLE_RETENTION_STATES,
  runnerHandleMachine,
  type RunnerHandleAction,
  type RunnerHandleFacts,
} from "./runner_handle_machine.js";
import { decideRunnerLifecycleStep } from "./runner_lifecycle_decision.js";
import {
  RUNNER_LIFECYCLE_STATES,
  RUNNER_LIFECYCLE_STEPS,
  runnerLifecycleMachine,
  type RunnerLifecycleDecision,
  type RunnerLifecycleState,
  type RunnerLifecycleStep,
} from "./runner_lifecycle_machine.js";
import { decideRunnerRecovery } from "./runner_recovery_decision.js";
import {
  RUNNER_RECOVERY_DISPOSITIONS,
  runnerRecoveryMachine,
  type RunnerRecoveryDisposition,
} from "./runner_recovery_machine.js";

export interface RunnerLifecycleDecisionRow {
  state: RunnerLifecycleState;
  step: RunnerLifecycleStep;
  commandMatches: boolean;
  decision: RunnerLifecycleDecision;
}

export interface RunnerRecoveryDecisionRow {
  retired: boolean;
  lifecycle: RunnerLifecycleState;
  pidAlive: boolean;
  bootstrapLeaseElapsed: boolean;
  disposition: RunnerRecoveryDisposition;
}

export interface RunnerCentralCheckDecisionRow {
  lookup: RunnerCentralLookup;
  terminalRetained: boolean;
  registrationAppliedAndTurnRunning: boolean;
  adoptResponse: RunnerAdoptResponse;
  decision: RunnerCentralCheckDecision;
}

export interface RunnerHandleDecisionRow extends RunnerHandleFacts {
  action: RunnerHandleAction;
}

export const RUNNER_PRECEDENCE_LABELS: Readonly<
  Record<RunnerLifecycleState, string>
> = {
  none: "기록 없음 (NULL)",
  running: "running",
  completed: "completed",
  failed: "failed",
  closed: "closed",
  reaped: "reaped",
};

export const RUNNER_STEP_LABELS: Readonly<Record<RunnerLifecycleStep, string>> = {
  begin: "begin",
  progress: "progress",
  liveness: "liveness",
  tool_started: "toolStarted",
  tool_finished: "toolFinished",
  finish_completed: "finish(completed)",
  finish_failed: "finish(failed)",
  finish_closed: "finish(closed)",
  reap: "reap",
};

export const RUNNER_DECISION_LABELS: Readonly<
  Record<RunnerLifecycleDecision, string>
> = {
  apply: "적용",
  reject: "거부",
  ignore: "무시",
};

export const RUNNER_DISPOSITION_LABELS: Readonly<
  Record<RunnerRecoveryDisposition, string>
> = {
  wait_for_bootstrap: "wait_for_bootstrap",
  adopt_prebootstrap: "adopt_prebootstrap",
  adopt_running: "adopt_running",
  replay_terminal: "replay_terminal",
  replay_terminal_dead: "replay_terminal_dead",
  retired_terminal: "retired_terminal",
  reap_dead: "reap_dead",
  already_reaped: "already_reaped",
  closed: "closed",
};

export const RUNNER_CENTRAL_LOOKUP_LABELS: Readonly<
  Record<RunnerCentralLookup, string>
> = {
  missing: "없음",
  lookup_error: "조회 오류",
  owner_node_changed: "소유 노드 바뀜",
  active: "활성",
  inactive: "활성 아님",
};

export const RUNNER_ADOPT_RESPONSE_LABELS: Readonly<
  Record<RunnerAdoptResponse, string>
> = {
  none: "없음",
  applied: "적용",
  retryable_rejection: "다시 될 수 있는 거절",
  terminal_rejection: "다시 될 까닭 없는 거절",
};

export const RUNNER_CENTRAL_DECISION_LABELS: Readonly<
  Record<RunnerCentralCheckDecision, string>
> = {
  reap: "거둠",
  adopt: "잇기",
  keep: "그대로 둠",
  keep_retry: "그대로 두고 간격 뒤 다시 판정",
};

export const RUNNER_HANDLE_ACTION_LABELS: Readonly<
  Record<RunnerHandleAction, string>
> = {
  recover_closed_engine_terminal: "닫힌 엔진 종료 복구",
  probe_detached_background: "백그라운드 보유 묻기",
  stop_detached_background: "백그라운드 보유로 그대로 둠",
  terminalize_dead_background: "죽은 백그라운드 종료로 적기",
  probe_expired_retention: "만료 보유 해제 묻기",
  stop_released_retention: "해제하고 은퇴해 끝냄",
  probe_attached_terminal: "붙은 종료 등록 은퇴 묻기",
  stop_retired_attached_terminal: "은퇴시키고 끝냄",
  retire_recorded_terminal: "재생 없이 종료 등록 은퇴",
  recover_by_disposition: "복구 가름으로 복구",
  terminalize_failed: "실패로 종결",
  recover_closed: "닫힌 복구",
  terminalize_reaped: "치운 종결",
  unsupported: "처리할 길 없음",
};

export const RUNNER_HANDLE_ACTION_CONDITIONS: Readonly<
  Record<RunnerHandleAction, string>
> = {
  recover_closed_engine_terminal: "task 있고 replay_terminal이고 닫힌 엔진 실패 종료",
  probe_detached_background: "task 있고 replay_terminal이고 백그라운드 보유를 아직 묻지 않음",
  stop_detached_background: "task 있고 replay_terminal이고 백그라운드 작업이 보유 중",
  terminalize_dead_background: "replay_terminal_dead이고 죽은 백그라운드 작업을 아직 적지 않음",
  probe_expired_retention: "task 있고 종료 확정이고 만료 보유 해제를 아직 묻지 않음",
  stop_released_retention: "task 있고 종료 확정이고 만료 보유를 해제함",
  probe_attached_terminal: "task 있고 종료 확정이고 붙은 종료 등록 은퇴를 아직 묻지 않음",
  stop_retired_attached_terminal: "task 있고 종료 확정이고 붙은 종료 등록을 은퇴시킴",
  retire_recorded_terminal: "task 있고 종료 확정이고 runner도 executionPromise도 없음",
  recover_by_disposition: "가름이 adopt_prebootstrap, adopt_running, replay_terminal, replay_terminal_dead",
  terminalize_failed: "가름이 reap_dead",
  recover_closed: "가름이 closed",
  terminalize_reaped: "가름이 already_reaped",
  unsupported: "나머지 가름",
};

/** 상태, 걸음, 번호 일치의 모든 조합에 판정을 낸다. 판정이 없으면 던진다. */
export function runnerLifecycleDecisionTable(): RunnerLifecycleDecisionRow[] {
  const rows: RunnerLifecycleDecisionRow[] = [];
  for (const state of RUNNER_LIFECYCLE_STATES) {
    for (const step of RUNNER_LIFECYCLE_STEPS) {
      for (const commandMatches of [true, false]) {
        rows.push({
          state,
          step,
          commandMatches,
          decision: decideRunnerLifecycleStep(state, step, commandMatches),
        });
      }
    }
  }
  return rows;
}

/** 복구 가름의 모든 입력 조합에 판정을 낸다. 판정이 없으면 던진다. */
export function runnerRecoveryDecisionTable(): RunnerRecoveryDecisionRow[] {
  const rows: RunnerRecoveryDecisionRow[] = [];
  for (const retired of [false, true]) {
    for (const lifecycle of RUNNER_LIFECYCLE_STATES) {
      for (const pidAlive of [false, true]) {
        for (const bootstrapLeaseElapsed of [false, true]) {
          rows.push({
            retired,
            lifecycle,
            pidAlive,
            bootstrapLeaseElapsed,
            disposition: decideRunnerRecovery({
              retired,
              lifecycle,
              pidAlive,
              bootstrapLeaseElapsed,
            }),
          });
        }
      }
    }
  }
  return rows;
}

/** 중앙 확인의 모든 입력 조합에 판정을 낸다. 판정이 없으면 던진다. */
export function runnerCentralCheckDecisionTable(): RunnerCentralCheckDecisionRow[] {
  const rows: RunnerCentralCheckDecisionRow[] = [];
  for (const lookup of RUNNER_CENTRAL_LOOKUPS) {
    for (const terminalRetained of [false, true]) {
      for (const registrationAppliedAndTurnRunning of [false, true]) {
        for (const adoptResponse of RUNNER_ADOPT_RESPONSES) {
          const facts = {
            lookup,
            terminalRetained,
            registrationAppliedAndTurnRunning,
            adoptResponse,
          };
          rows.push({
            ...facts,
            decision: decideRunnerCentralCheck(facts),
          });
        }
      }
    }
  }
  return rows;
}

/** 복구 처리의 모든 입력 조합에 조치를 낸다. 조치가 없으면 던진다. */
export function runnerHandleDecisionTable(): RunnerHandleDecisionRow[] {
  const rows: RunnerHandleDecisionRow[] = [];
  for (const disposition of RUNNER_RECOVERY_DISPOSITIONS) {
    for (const hasTask of [false, true]) {
      for (const recordedTerminal of [false, true]) {
        for (const closedEngineTerminal of [false, true]) {
          for (const detachedBackground of RUNNER_HANDLE_BACKGROUND_STATES) {
            for (const retention of RUNNER_HANDLE_RETENTION_STATES) {
              for (const attachedTerminal of RUNNER_HANDLE_ATTACHED_TERMINAL_STATES) {
                for (const deadBackgroundTerminalized of [false, true]) {
                  for (const hasRunner of [false, true]) {
                    for (const hasExecutionPromise of [false, true]) {
                      const facts: RunnerHandleFacts = {
                        disposition,
                        hasTask,
                        recordedTerminal,
                        closedEngineTerminal,
                        detachedBackground,
                        retention,
                        attachedTerminal,
                        deadBackgroundTerminalized,
                        hasRunner,
                        hasExecutionPromise,
                      };
                      rows.push({ ...facts, action: decideRunnerHandle(facts) });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return rows;
}

/**
 * 복구 처리 기계 정의에서 조치 순서를 낸다. 문서와 정의가 어긋나지 않게 한다.
 */
export function runnerHandleActionOrder(): RunnerHandleAction[] {
  const state = runnerHandleMachine.root.states.decide;
  type Verdict = { params?: { action?: RunnerHandleAction } };
  const transitions = state?.on?.HANDLE as unknown as Array<{
    actions?: Verdict | Verdict[];
  }> | undefined;
  if (!transitions) throw new Error("runner handle machine has no HANDLE transitions");
  return transitions.map((transition) => {
    const actions = Array.isArray(transition.actions)
      ? transition.actions
      : transition.actions
        ? [transition.actions]
        : [];
    const action = actions.find((candidate) => candidate.params?.action)
      ?.params?.action;
    if (!action) throw new Error("runner handle transition has no action verdict");
    return action;
  });
}

interface ChartPlan {
  id: string;
  title: string;
  note: string;
  spec: ChartSpec;
}

function chartPlans(): ChartPlan[] {
  return [
    {
      id: "01-lifecycle",
      title: "수명 기록 전이",
      note: "begin은 어느 상태에서나 running으로 다시 연다. 끝남과 치우기는 running에서만 적용된다.",
      spec: {
        include: ["runnerLifecycle"],
        hideEvents: ["PROGRESS", "LIVENESS", "TOOL_STARTED", "TOOL_FINISHED"],
        parallel: "stack",
      },
    },
    {
      id: "02-observations",
      title: "실행 중 관찰",
      note: "진행, 생존, 도구 시작과 끝은 running이고 실행 명령 번호가 같을 때만 적는다.",
      spec: {
        include: ["runnerLifecycle"],
        hideEvents: [
          "BEGIN",
          "FINISH_COMPLETED",
          "FINISH_FAILED",
          "FINISH_CLOSED",
          "REAP",
        ],
        parallel: "stack",
      },
    },
  ];
}

function validateChartDescriptions(): void {
  const walk = (node: typeof runnerLifecycleMachine.root): void => {
    for (const transitions of Object.values(node.on)) {
      for (const transition of transitions) {
        if (transition.description === undefined) {
          throw new Error(`Missing transition description: ${node.id} ${transition.eventType}`);
        }
      }
    }
    Object.values(node.states).forEach(walk);
  };
  walk(runnerLifecycleMachine.root);
}

export function generateRunnerStateDocument() {
  validateChartDescriptions();
  const lifecycleRows = runnerLifecycleDecisionTable();
  const recoveryRows = runnerRecoveryDecisionTable();
  const centralRows = runnerCentralCheckDecisionTable();
  const handleActions = runnerHandleActionOrder();
  const handleCombinations = RUNNER_RECOVERY_DISPOSITIONS.length
    * 2 * 2 * 2
    * RUNNER_HANDLE_BACKGROUND_STATES.length
    * RUNNER_HANDLE_RETENTION_STATES.length
    * RUNNER_HANDLE_ATTACHED_TERMINAL_STATES.length
    * 2 * 2 * 2;
  const charts = chartPlans().map((plan) => ({
    ...plan,
    ...toMermaid(runnerLifecycleMachine.root, plan.spec),
  }));
  for (const chart of charts) {
    if (chart.warnings.length > 0) {
      throw new Error(`${chart.id}: ${chart.warnings.join(", ")}`);
    }
  }

  const lines: string[] = [
    "# 러너 수명 기록 상태",
    "",
    "이 문서는 `soul-server-ts/src/runner/state/`의 XState 정의에서 만든 생성물이다. 정의를 고치면 아래 명령으로 다시 만든다. 리포의 파일과 생성 결과가 다르면 시험이 실패한다.",
    "",
    "## 저장 상태",
    "",
    "| 상태 | 저장 문자열 |",
    "| :-- | :-- |",
  ];
  for (const state of RUNNER_LIFECYCLE_STATES) {
    lines.push(`| ${RUNNER_PRECEDENCE_LABELS[state]} | ${state === "none" ? "NULL" : state} |`);
  }
  lines.push(
    "",
    "## 수명 기록 결정표",
    "",
    "상태, 걸음, 실행 명령 번호 일치의 모든 조합이다. 빈 칸은 없다. `begin`은 번호와 무관하게 어느 상태에서나 적용한다. 나머지 걸음은 running이고 번호가 같을 때만 적용한다. closed와 reaped에 온 늦은 끝남은 수명 기록을 바꾸지 않고 무시한다.",
    "",
    "| 상태 | 걸음 | 번호 일치 | 판정 |",
    "| :-- | :-- | :-- | :-- |",
  );
  for (const row of lifecycleRows) {
    lines.push(
      `| ${RUNNER_PRECEDENCE_LABELS[row.state]} | ${RUNNER_STEP_LABELS[row.step]} | ${row.commandMatches ? "같음" : "다름"} | ${RUNNER_DECISION_LABELS[row.decision]} |`,
    );
  }
  lines.push(
    "",
    "## 복구 가름 결정표",
    "",
    "은퇴 표시, 수명 상태, pid 생존, 부트스트랩 임대 경과의 모든 조합이다. 판정 순서는 은퇴, 치워짐, 닫힘, 기록 없음, 끝남, 실행 중 순이다.",
    "",
    "| 은퇴 표시 | 수명 상태 | pid 생존 | 임대 경과 | 판정 |",
    "| :-- | :-- | :-- | :-- | :-- |",
  );
  for (const row of recoveryRows) {
    lines.push(
      `| ${row.retired ? "있음" : "없음"} | ${RUNNER_PRECEDENCE_LABELS[row.lifecycle]} | ${row.pidAlive ? "살아 있음" : "죽음"} | ${row.bootstrapLeaseElapsed ? "지남" : "남음"} | ${RUNNER_DISPOSITION_LABELS[row.disposition]} |`,
    );
  }
  lines.push(
    "",
    "## 중앙 확인 결정표",
    "",
    "러너를 중앙 세션 한 줄과 대조한 모든 입력 조합이다. 조회는 hydrate나 메모리 캐시를 거치지 않고 세션 한 줄을 직접 읽는다. 판정 순서는 다시 될 까닭 없는 잇기 거절, 없음, 소유 노드 바뀜, 조회 오류, 활성, 다시 될 수 있는 잇기 거절, 종료 확정 정상 보유, 등록 적용 턴 실행, 나머지 활성 아님 순이다.",
    "",
    "| 조회 결과 | 종료 확정 정상 보유 | 등록 적용 턴 실행 | 직전 잇기 응답 | 판정 |",
    "| :-- | :-- | :-- | :-- | :-- |",
  );
  for (const row of centralRows) {
    lines.push(
      `| ${RUNNER_CENTRAL_LOOKUP_LABELS[row.lookup]} | ${row.terminalRetained ? "맞음" : "아님"} | ${row.registrationAppliedAndTurnRunning ? "맞음" : "아님"} | ${RUNNER_ADOPT_RESPONSE_LABELS[row.adoptResponse]} | ${RUNNER_CENTRAL_DECISION_LABELS[row.decision]} |`,
    );
  }
  lines.push(
    "",
    "## 복구 처리 조치 순서",
    "",
    "`handle()`이 고르는 조치는 아래 순서대로다. 물어봐야 아는 조치는 handle()이 실행하고 결과를 사실에 적어 다시 판정한다. 입력 조합 " + `${handleCombinations}` + "가지 모두에 판정이 있으며 빈 칸은 없다.",
    "",
    "| 순서 | 조치 | 조건 |",
    "| :-- | :-- | :-- |",
  );
  handleActions.forEach((action, index) => {
    lines.push(
      `| ${index + 1} | ${RUNNER_HANDLE_ACTION_LABELS[action]} | ${RUNNER_HANDLE_ACTION_CONDITIONS[action]} |`,
    );
  });
  lines.push("", "## 그림", "");
  for (const chart of charts) {
    lines.push(
      `### ${chart.title}`,
      "",
      "```mermaid",
      chart.mermaid,
      "```",
      "",
      `${chart.note} 전이 화살표 ${chart.edgeCount}개.`,
      "",
    );
  }
  lines.push(
    "## 다시 만들기",
    "",
    "```bash",
    "corepack pnpm@10.32.1 --dir soul-server-ts exec tsx scripts/runner-state-charts.ts",
    "```",
    "",
    `결정표는 수명 기록 ${lifecycleRows.length}행, 복구 가름 ${recoveryRows.length}행, 중앙 확인 ${centralRows.length}행이다. 복구 판정 값은 ${RUNNER_RECOVERY_DISPOSITIONS.join(", ")}다. 중앙 확인 판정 값은 ${RUNNER_CENTRAL_CHECK_DECISIONS.join(", ")}다.`,
    "",
  );
  return { markdown: lines.join("\n"), charts, lifecycleRows, recoveryRows, centralRows };
}

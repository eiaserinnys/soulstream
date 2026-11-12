import { toMermaid, type ChartSpec } from "@soulstream/statechart";

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
    `결정표는 수명 기록 ${lifecycleRows.length}행, 복구 가름 ${recoveryRows.length}행이다. 복구 판정 값은 ${RUNNER_RECOVERY_DISPOSITIONS.join(", ")}다.`,
    "",
  );
  return { markdown: lines.join("\n"), charts, lifecycleRows, recoveryRows };
}

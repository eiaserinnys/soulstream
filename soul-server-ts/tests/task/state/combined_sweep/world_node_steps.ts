/**
 * 합친 훑기 세계의 노드 걸음이다(카드 #1266 U5c). 걸음마다 원본 M의 줄을 단다.
 * 짝이 있는 걸음은 제품 판정 함수로 다음 구성을 고른다. 걸음이 일어날 수 있는 조건은 M을 따른다.
 */
import type { RunnerHandleFacts } from "../../../../src/runner/state/runner_handle_machine.js";
import type { RunnerLifecycleState } from "../../../../src/runner/state/runner_lifecycle_machine.js";
import type { WorldContext } from "./world_context.js";
import {
  ACTIVE,
  CUT2,
  LIMITISH,
  NO_RUNNER,
  RECORDED,
  WAITING,
  baseMsg,
  conn,
  keyOf,
  put,
  stale,
  type G,
  type RunnerLife,
} from "./world_state.js";

export type StepFn = (g: G) => G[];

/** 모형의 러너 수명을 제품의 수명 기록으로 옮긴다. 한도 끝남과 정상 보유는 완료 기록이다. */
export function lifecycleOf(life: RunnerLife): RunnerLifecycleState {
  switch (life) {
    case "none":
      return "none";
    case "running":
      return "running";
    case "ended":
    case "ended_l":
    case "held":
      return "completed";
    case "reaped":
      return "reaped";
  }
}

export function nodeSteps(ctx: WorldContext): Record<string, StepFn> {
  const { options, counters, emit, loseHandover } = ctx;
  const d = options.decisions;
  const { k2 } = options;

  // J01 지시가 온다 (M:164-169). 처분은 decideNodeRequest가 낸다.
  const instruction: StepFn = (g) => {
    if (!conn(g) || g.q === "waiting" || g.q === "handing") return [];
    const disposition = d.nodeRequest(ctx.phase(g), "intervene");
    if (disposition === "deliver_or_queue" && g.q !== "blocked" && g.l2 === "up" && g.d2.length < k2) {
      return [put(g, { q: "handing", d2: [...g.d2, "HAND"] })];
    }
    return [put(g, { q: "waiting" })];
  };

  // J02 쌓인 지시로 다시 띄운다 (M:171-174).
  const selfRelaunch: StepFn = (g) =>
    g.ex === "idle" && g.q === "waiting" && g.p === "none" ? emit(g, "RESUME", { ex: "resume_w" }) : [];

  // J03 러너가 뜬다 (M:176-179).
  const spawnOk: StepFn = (g) =>
    g.ex === "gate"
      ? emit(g, "REG", { ex: "reg_w", p: "up", life: "none", tail: "clean", l2: "up", d2: [], u2: [] })
      : [];

  // J06 실행 명령을 다시 보낸다 (M:181-185).
  const execResend: StepFn = (g) =>
    g.ex === "turn" && g.l2 === "up" && g.p === "up" && g.life === "none"
      && !g.d2.includes("EXEC") && g.d2.length < k2
      ? [put(g, { d2: [...g.d2, "EXEC"] })]
      : [];

  // J04 다음 턴이 쌓인 지시를 가져간다 (M:187-190).
  const nextTurn: StepFn = (g) =>
    g.ex === "turn" && g.q === "waiting" && g.life === "running" ? [put(g, { q: "empty" })] : [];

  // J05 노드가 러너의 끝남을 안다 (M:192-199).
  const learnEnd: StepFn = (g) => {
    if (g.ex !== "turn" || g.l2 !== "up" || g.p !== "up" || (g.life !== "ended" && g.life !== "ended_l")
      || g.d2.includes("EXEC")) return [];
    if (g.life === "ended" && g.q === "waiting") {
      return g.d2.length < k2 ? [put(g, { q: "empty", d2: [...g.d2, "EXEC"] })] : [];
    }
    return [put(g, { ex: "replay" })];
  };

  // J07 사람이 멈춘다 (M:201-209). 처분은 decideNodeRequest와 decideNodeStopRequest가 낸다.
  const stop: StepFn = (g) => {
    if (!(conn(g) && g.ex === "turn")) return [];
    const disposition = d.nodeRequest(ctx.phase(g), "stop");
    if (disposition !== "interrupt_and_terminate") {
      throw new Error(`unmapped stop disposition in a turn: ${disposition}`);
    }
    const barrier = g.q === "handing" ? "intervention_handoff" : "none";
    if (d.nodeStopRequest(barrier) === null) {
      // 멈춤도 거절도 아닌 채 돌아간다 (후보 라의 옛 동작).
      counters.vanishedStop.add(keyOf(g));
      return [];
    }
    if (g.l2 === "up" && g.d2.length < k2) return [put(g, { ex: "stopping", st: "req", d2: [...g.d2, "INT"] })];
    return [put(g, { ex: "stopping", st: "req" })];
  };

  // J08 멈춤이 정리된다 (M:211-214). 멈춤 장벽을 내리는 걸음은 stepNodeBarrier가 낸다.
  const stopDone: StepFn = (g) => {
    if (g.ex !== "stopping") return [];
    const step = d.nodeBarrier("stop", "STOP_DONE");
    if (step.state !== "none") throw new Error(`stop barrier did not fall: ${step.state}`);
    return emit(g, "T_STOP", { ex: "end_w" });
  };

  // J09 띄우기에 실패한다 [다시 해 볼 만한 실패] (M:216-220).
  const launchFailRetry: StepFn = (g) => {
    if (g.ex !== "gate" || g.S === "init") return [];
    const out = emit(g, "T_COPY", { ex: "copy_w" });
    return [...out, ...out.filter((x) => x.q === "waiting").map((x) => put(x, { q: "empty" }))];
  };

  // J10 띄우기에 실패한다 [고쳐지지 않을 실패] (M:222-228).
  const launchFailFatal: StepFn = (g) => {
    if (g.ex !== "gate") return [];
    const out = emit(g, "T_END", { ex: "end_w" });
    if (g.q === "waiting") return out.flatMap((x) => [put(x, { q: "empty" }), put(x, { q: "blocked" })]);
    return out;
  };

  // J11 노드가 러너의 죽음을 안다 (M:230-234).
  const nodeSeesDeath: StepFn = (g) => {
    if ((g.ex !== "turn" && g.ex !== "stopping") || g.p !== "dead") return [];
    const life = g.life === "none" || g.life === "running" ? "reaped" : g.life;
    return [put(g, { ex: "replay", life, tail: "dirty" })];
  };

  // J13 러너의 남은 기록이 서버에 다 닿는다 (M:236-243).
  const replayDone: StepFn = (g) => {
    if (g.ex !== "replay" || !conn(g)) return [];
    const out = emit(g, g.life === "ended_l" ? "T_LIMIT" : "T_END", { ex: "end_w", tail: "clean" });
    if (out.length > 0 && g.tail === "clean") counters.republishedEnd.add(keyOf(g));
    return out;
  };

  // J14 노드가 재시작한다 (M:245-251). I6 고침(requeue)은 세계 스위치다.
  const restart: StepFn = (g) => {
    let q = loseHandover(g, "J14");
    if (q === "waiting" || q === "blocked") {
      // 메모리 대기 줄은 사라진다. 클로드는 대화 기록으로 다시 잇고, 코덱스는 장부 복구가 있어야 잇는다.
      q = options.codex && !options.requeue ? "lost" : "waiting";
    }
    return [put(g, {
      ex: "idle", q, ch: stale(g.ch), L: conn(g) ? "grace" : g.L, ...CUT2,
    })];
  };

  // J15 복구 훑기가 돈다 (M:253-269). 가름은 decideRunnerRecovery, 조치는 decideRunnerHandle이 낸다.
  const recover: StepFn = (g) => {
    if (g.ex !== "idle" || g.p === "none") return [];
    const disposition = d.runnerRecovery({
      retired: false,
      lifecycle: lifecycleOf(g.life),
      pidAlive: g.p === "up",
      bootstrapLeaseElapsed: true,
    });
    const held = g.life === "held" && g.p === "up";
    let facts: RunnerHandleFacts = {
      disposition,
      hasTask: true,
      recordedTerminal: RECORDED.has(g.S),
      closedEngineTerminal: false,
      detachedBackground: "not_probed",
      retention: "not_probed",
      attachedTerminal: "not_probed",
      deadBackgroundTerminalized: false,
      hasRunner: true,
      hasExecutionPromise: false,
    };
    for (let round = 0; round < 8; round += 1) {
      const action = d.runnerHandle(facts);
      switch (action) {
        case "probe_detached_background":
          facts = { ...facts, detachedBackground: held ? "retained" : "absent" };
          continue;
        case "terminalize_dead_background":
          facts = { ...facts, deadBackgroundTerminalized: true };
          continue;
        case "probe_expired_retention":
          facts = { ...facts, retention: held ? "not_released" : "released" };
          continue;
        case "probe_attached_terminal":
          facts = { ...facts, attachedTerminal: held ? "open" : "retired" };
          continue;
        case "stop_detached_background":
          // 정상 보유: 복구 훑기는 건드리지 않는다 (M:256-258, C5).
          return [];
        case "stop_released_retention":
        case "stop_retired_attached_terminal":
        case "retire_recorded_terminal":
          // 종료가 이미 기록됨: 재생 없이 은퇴 (M:260-262, 셋째 판에 notify_rec 없음). 보유 러너가 죽은 꼴(M:259)도 이 가지로 온다.
          return [put(g, { q: loseHandover(g, "J15"), ...NO_RUNNER })];
        case "recover_by_disposition":
          if (disposition === "adopt_prebootstrap" || disposition === "adopt_running") {
            return emit(g, "ADOPT", { ex: "adopt_w", l2: "up", d2: [], u2: [] }); // M:263-264
          }
          if (disposition === "replay_terminal") {
            return [put(g, { ex: "replay", p: "dead", q: loseHandover(g, "J15"), ...CUT2 })]; // M:265-266
          }
          if (disposition === "replay_terminal_dead") return [put(g, { ex: "replay" })]; // M:269
          throw new Error(`unmapped recovery disposition: ${disposition}`);
        case "terminalize_failed":
          return [put(g, { ex: "replay", life: "reaped", tail: "dirty" })]; // M:267-268
        case "terminalize_reaped":
        case "recover_closed":
          return [put(g, { ex: "replay" })]; // M:269
        default:
          throw new Error(`unmapped runner handle action: ${action}`);
      }
    }
    throw new Error("runner handle probe loop did not settle");
  };

  // J16 끊긴 채 응답을 기다리다 시간이 넘는다 (M:271-276). 셋째 판에 응답까지 쥠(hold) 없음.
  const waitTimeout: StepFn = (g) => {
    if (WAITING[g.ex] === undefined || conn(g)) return [];
    const q = loseHandover(g, "J16");
    if (g.ex === "reg_w") return [put(g, { ex: "idle", ch: stale(g.ch), q, ...NO_RUNNER })];
    return [put(g, { ex: "idle", ch: stale(g.ch), q, ...CUT2 })];
  };

  // J17 한도가 풀려 예약 시각이 된다 (M:278-289). 어긋남 1(wake) 고침이 들어 있다.
  const fire: StepFn = (g) => {
    if (!conn(g) || (g.W !== "armed" && g.W !== "stale")) return [];
    if (LIMITISH.has(g.S)) return g.ex === "idle" ? [put(g, { W: "none", q: "waiting" })] : [];
    if (g.S === "relaunch_l") return [];
    return [put(g, { W: "none" })];
  };

  // J41 종료 정리가 러너를 닫는다 (또는 정상 보유로 둔다) (M:297-308). 셋째 판에 notify_first 없음.
  const finClose: StepFn = (g) => {
    if (g.ex !== "fin1") return [];
    const q = loseHandover(g, "J41");
    const outs = [put(g, { ex: "fin2", q, ...NO_RUNNER })];
    if (g.p === "up" && (g.life === "ended" || g.life === "ended_l")) {
      outs.push(put(g, { ex: "fin2", life: "held", q, ...CUT2 }));
    }
    return outs;
  };

  // J42 종료 정리가 완료 전달을 등록한다 (M:310-313).
  const finNotify: StepFn = (g) => (g.ex === "fin2" ? [put(g, { ex: "idle", nt: "-" })] : []);

  // J44 노드가 미결로 남은 완료 정산을 마친다 (M:315-320). I3 고침은 세계 스위치다.
  const settlePending: StepFn = (g) =>
    options.settlePending && g.nt === "due" && g.ex === "idle" ? [put(g, { nt: "-" })] : [];

  // J45 주기 중앙 확인이 잇기를 보낸다 (M:322-328). 판정은 decideRunnerCentralCheck가 낸다.
  // 확인이 도는 조건(연결, 살아 있는 러너, 보낸 잇기 없음)은 M을 따르고 나머지는 판정에 맡긴다.
  const centralProbe: StepFn = (g) => {
    if (!conn(g) || g.p !== "up" || g.ch.some((m) => baseMsg(m) === "ADOPT")) return [];
    const decision = d.runnerCentralCheck({
      lookup: ACTIVE.has(g.S) ? "active" : "inactive",
      terminalRetained: g.life === "held" && RECORDED.has(g.S),
      registrationAppliedAndTurnRunning: g.ex === "turn",
      // 모형은 주기마다 그때의 상태로 새로 판정한다(design.md 「잇기의 시도 번호」).
      adoptResponse: "none",
    });
    if (decision === "keep") return [];
    if (decision === "adopt") return emit(g, "ADOPT", { ex: "adopt_w" });
    throw new Error(`unmapped central check decision: ${decision}`);
  };

  // J43 정상 보유가 풀린다 (M:330-333).
  const holdReleased: StepFn = (g) =>
    g.ex === "idle" && g.p === "up" && g.life === "held" ? [put(g, { ...NO_RUNNER })] : [];

  return {
    J01: instruction, J02: selfRelaunch, J03: spawnOk, J04: nextTurn, J05: learnEnd, J06: execResend,
    J07: stop, J08: stopDone, J09: launchFailRetry, J10: launchFailFatal, J11: nodeSeesDeath,
    J13: replayDone, J14: restart, J15: recover, J16: waitTimeout, J17: fire,
    J41: finClose, J42: finNotify, J43: holdReleased, J44: settlePending, J45: centralProbe,
  };
}

/**
 * 합친 훑기 세계의 통로, 러너, 연결과 서버 걸음이다(카드 #1266 U5c). 걸음마다 원본 M의 줄을 단다.
 *
 * 서버 걸음은 M에서 손으로 옮겼다. orch의 decideSessionTransition은 세션 줄 하나의 상태 값만 받고
 * 한도 재개 예약은 읽기 전용 투영이라, M의 서버 상태가 가르는 한도 끝남, 베낀 끝남, 묻힌 끝남과 예약을 담지 못한다.
 * 고침은 셋째 판의 안(d3, d2, wake, c3, hol, watch, revive_adopt)이 모두 들어 있다.
 * 거절 사유는 orch의 판정 순서와 와이어 사유표(session_decision_guards.ts, SESSION_REJECTION_REASON_WIRE)를 따랐다:
 * 워크트리 점유가 종료 상태 검사보다 앞서고, terminal_without_resume은 already_terminal로 실린다.
 */
import type { NodeResponseDecision } from "../../../../src/task/state/node_response_decision.js";
import type { NodeResponseCall, NodeResponseFacts, NodeWireReason } from "../../../../src/task/state/node_response_machine.js";
import { RESPONSE_CALL, type WorldContext } from "./world_context.js";
import { lifecycleOf, type StepFn } from "./world_node_steps.js";
import {
  ACTIVE,
  CONNECTED,
  CUT2,
  LIMITISH,
  NODE_RUNNING,
  NO_RUNNER,
  RECORDED,
  RUNNING,
  TERMS,
  UNREC,
  WAITING,
  baseMsg,
  conn,
  keyOf,
  put,
  type G,
  type WakeState,
} from "./world_state.js";

interface ServerVerdict {
  applied: boolean;
  outs: G[];
  reason: NodeWireReason;
}

const TERMINAL_STATES = new Set([...RECORDED, ...UNREC]);

function inList(g: G): boolean {
  // M:160-161
  return NODE_RUNNING.has(g.ex) || (g.p === "up" && g.life !== "held");
}

/** 서버가 사건 하나를 적용한다 (M:336-382). g는 적용 전 구성, base는 그 사건을 줄에서 뺀 구성이다. */
function serverApply(g: G, base: G, msg: string): ServerVerdict {
  const { S, W } = g;
  const occ = g.wt === "occ";
  if (msg === "RESUME") {
    if (TERMINAL_STATES.has(S)) {
      const applied = !occ;
      return {
        applied,
        outs: [applied ? put(base, { S: LIMITISH.has(S) ? "relaunch_l" : "relaunch" }) : base],
        reason: applied ? "none" : "worktree_busy",
      };
    }
    return { applied: true, outs: [base], reason: "none" };
  }
  if (msg === "ADOPT") {
    // R1: 잇기 알림에 한해 끊김 중단을 되살린다 (revive_adopt).
    const applied = ACTIVE.has(S) || (S === "cut" && !occ);
    const next = S === "init" ? "relaunch" : applied && S === "cut" ? "run_reg" : S;
    return {
      applied,
      outs: [put(base, { S: next })],
      reason: applied ? "none" : occ && TERMINAL_STATES.has(S) ? "worktree_busy" : "already_terminal",
    };
  }
  if (msg === "REG") {
    // 실행 등록으로는 되살리지 않는다.
    const applied = ACTIVE.has(S);
    return {
      applied,
      outs: [applied ? put(base, { S: "run_reg", W: W === "skipped" ? "none" : W }) : base],
      reason: applied ? "none" : occ ? "worktree_busy" : "already_terminal",
    };
  }
  if (TERMS.has(msg)) {
    // 어긋남 3 (d3): 끊김 중단에 닿은 종료를 받아 적용한다.
    if (ACTIVE.has(S) || S === "cut") {
      const nt = msg === "T_STOP" ? g.nt : "due"; // 사람의 멈춤은 완료 보고가 아니다
      if (msg === "T_LIMIT") {
        const keep: WakeState = ({ none: "none", skipped: "none", armed: "armed", stale: "armed" } as const)[W];
        const outs = [put(base, { S: "limit", W: keep, nt, st: "-" })];
        if (keep !== "armed") outs.push(put(base, { S: "limit", W: "armed", nt, st: "-" }));
        return { applied: true, outs, reason: "none" };
      }
      return { applied: true, outs: [put(base, { S: "ended", nt, st: "-" })], reason: "none" };
    }
    return { applied: false, outs: [base], reason: "none" };
  }
  if (msg === "T_COPY") {
    if (ACTIVE.has(S)) {
      // 어긋남 1 (wake) 고침으로 베낀 한도 끝남이 예약을 낡게 하지 않는다.
      return { applied: true, outs: [put(base, { S: S === "relaunch_l" ? "limit_copy" : "end_copy", W })], reason: "none" };
    }
    if (S === "cut") return { applied: true, outs: [put(base, { S: "end_copy" })], reason: "none" };
    return { applied: false, outs: [base], reason: "none" };
  }
  throw new Error(`unknown message: ${msg}`);
}

export function channelSteps(ctx: WorldContext): Record<string, StepFn> {
  const { options, counters, loseHandover } = ctx;
  const d = options.decisions;
  const { k2 } = options;

  const decideResponse = (g: G, call: NodeResponseCall, facts: Omit<NodeResponseFacts, "call">): NodeResponseDecision => {
    const decision = d.nodeResponse({ call, ...facts });
    if (call === "startup_recovery_adopt") {
      // 붙은 러너 잇기도 같은 칸을 내야 G가 둘을 가르지 않아도 된다.
      const attached = d.nodeResponse({ call: "attached_runner_adopt", ...facts });
      if (JSON.stringify(attached) !== JSON.stringify(decision)) {
        throw new Error(`adopt calls disagree at ${keyOf(g)}: ${JSON.stringify([decision, attached])}`);
      }
    }
    return decision;
  };

  const responseFacts = (g: G, o: G, msg: string, reason: NodeWireReason, route: NodeResponseFacts["route"]) => ({
    route,
    reason,
    registration: "same" as const,
    termination: (TERMS.has(msg) || msg === "T_COPY") && RECORDED.has(g.S) ? "different" as const : "absent" as const,
    centralSession: "present" as const,
    retained: o.life === "held" && o.p === "up",
  });

  /** 노드가 응답을 받는다 (M:383-422). 거절이면 decideNodeResponse의 칸과 의도로 M의 가지를 고른다. */
  const apply = (g: G, base: G, raw: string): G[] => {
    const msg = baseMsg(raw);
    const { applied, outs, reason } = serverApply(g, base, msg);
    const result: G[] = [];
    for (const o of outs) {
      const want = WAITING[o.ex];
      const waited = !raw.endsWith("~") && (want === msg || (want === "T" && TERMS.has(msg)));
      if (!waited) {
        result.push(o);
        continue;
      }
      const call = RESPONSE_CALL[o.ex];
      const rejected = applied || call === undefined
        ? undefined
        : decideResponse(o, call, responseFacts(g, o, msg, reason, "applied_false"));
      if (rejected && rejected.cell === "applied") throw new Error(`rejection judged applied at ${keyOf(g)}`);
      const intents = new Set<string>(rejected?.intents ?? []);
      if (o.ex === "resume_w") {
        // 되살리기가 거절됨: 이 시도를 그만두고 지시는 보낸 쪽에 돌려준다 (M:390-394, 추정).
        result.push(applied ? put(o, { ex: "gate" }) : put(o, { ex: "idle", q: o.q === "waiting" ? "blocked" : o.q }));
      } else if (o.ex === "reg_w" || o.ex === "adopt_w") {
        if (applied && o.p === "dead") {
          const life = o.life === "none" || o.life === "running" ? "reaped" : o.life;
          result.push(put(o, { ex: "replay", life, tail: "dirty" }));
        } else if (applied && o.ex === "reg_w") {
          const d2 = o.l2 === "up" && o.d2.length < k2 ? [...o.d2, "EXEC" as const] : o.d2;
          result.push(put(o, { ex: "turn", q: o.q === "waiting" ? "empty" : o.q, d2 }));
        } else if (applied) {
          result.push(put(o, { ex: "turn" }));
        } else if (o.ex === "reg_w") {
          // 실행 시도의 거절은 칸과 상관없이 붙인 러너를 닫는다(task_executor abandonRejectedAttempt, M:404-405).
          result.push(put(o, { ex: "idle", q: loseHandover(o, "J19", g), ...NO_RUNNER }));
        } else if (intents.has("reap_runner") && intents.has("mark_central_error")) {
          // 러너를 거두고 오류 종료를 올린다 (M:408-412).
          const life = o.life === "none" || o.life === "running" ? "reaped" : o.life;
          result.push(put(o, { ex: "replay", p: "dead", life, tail: "dirty", q: loseHandover(o, "J19", g), ...CUT2 }));
        } else if (intents.has("reap_runner")) {
          // 다시 될 까닭 없는 거절: 러너를 거둔다 (M:406-407).
          result.push(put(o, { ex: "idle", q: loseHandover(o, "J19", g), ...NO_RUNNER }));
        } else {
          // 다시 될 수 있는 거절이나 정상 보유: 거두지 않고 다음 주기에 다시 잇는다 (M:413-414, design.md:42).
          result.push(put(o, { ex: "idle", q: loseHandover(o, "J19", g), ...CUT2 }));
        }
      } else if (o.ex === "end_w") {
        if (applied) {
          result.push(put(o, { ex: "fin1" }));
        } else if (intents.has("retire_rejected_registration")) {
          // 거절된 종료: 미결을 닫고 그 등록을 은퇴시킨다 (M:418-419).
          result.push(put(o, { ex: "idle", q: loseHandover(o, "J19", g), ...NO_RUNNER }));
        } else {
          throw new Error(`unmapped termination rejection: ${JSON.stringify(rejected)} at ${keyOf(g)}`);
        }
      } else {
        result.push(put(o, { ex: "idle" })); // M:420-421
      }
    }
    return result;
  };

  // J19 통로 하나의 맨 앞 사건이 서버에 닿는다 (M:424-427).
  const deliver: StepFn = (g) => (!conn(g) || g.ch.length === 0 ? [] : apply(g, put(g, { ch: g.ch.slice(1) }), g.ch[0]!));

  // J34 맨 앞 사건이 한 번 실패해 뒤 사건이 먼저 적용된다 (M:429-432). I1(hol) 고침으로 일어나지 않는다.
  const reorder: StepFn = () => [];

  // J35 맨 앞 사건이 영구 거절된다 (M:434-448). 칸은 decideNodeResponse가 낸다.
  // 영구 거절 칸(I2)이면 소유를 놓고 목록을 다시 보낸다. 칸의 중앙 오류 표시는 M대로 목록 다시 보냄으로 둔다.
  const permReject: StepFn = (g) => {
    if (!conn(g) || g.ch.length === 0) return [];
    const raw = g.ch[0]!;
    const msg = baseMsg(raw);
    const base = put(g, { ch: g.ch.slice(1) });
    const want = WAITING[g.ex];
    if (raw.endsWith("~") || !(want === msg || (want === "T" && TERMS.has(msg)))) return [base];
    const call = RESPONSE_CALL[g.ex];
    let L = g.L;
    if (call !== undefined) {
      const decision = decideResponse(g, call, responseFacts(g, g, msg, "none", "dead_letter"));
      if (decision.cell === "permanent" || decision.cell === "quarantine") L = "unrep";
    }
    const q = g.q === "handing" ? "waiting" : g.q;
    if (g.ex === "reg_w" || g.ex === "end_w") return [put(base, { ex: "idle", q, L, ...NO_RUNNER })];
    return [put(base, { ex: "idle", q, L, ...CUT2 })];
  };

  // J26 러너가 명령을 받는다 (M:450-467). 수명 기록의 판정은 decideRunnerLifecycleStep이 낸다.
  const runnerFrame: StepFn = (g) => {
    if (g.l2 !== "up" || g.p !== "up" || g.d2.length === 0) return [];
    const frame = g.d2[0]!;
    const base = put(g, { d2: g.d2.slice(1) });
    if (frame === "EXEC") {
      const decision = d.runnerLifecycle(lifecycleOf(g.life), "begin", true);
      return [decision === "apply" ? put(base, { life: "running" }) : base];
    }
    if (frame === "INT") {
      const decision = d.runnerLifecycle(lifecycleOf(g.life), "finish_completed", true);
      return [decision === "apply" ? put(base, { life: "ended", tail: "dirty" }) : base];
    }
    if (g.u2.length >= k2) return [];
    return [put(base, { u2: [...g.u2, g.life === "running" ? "H_OK" : "H_NO"] })];
  };

  // J27 노드가 러너의 결과를 받는다 (M:469-476). 처분은 decideNodeInstruction이 낸다.
  const nodeFrame: StepFn = (g) => {
    if (g.l2 !== "up" || g.u2.length === 0) return [];
    const frame = g.u2[0]!;
    const base = put(g, { u2: g.u2.slice(1) });
    if (g.q !== "handing") return [base];
    const decision = d.nodeInstructionReply({ verdict: frame === "H_OK" ? "applied" : "not_applied", ledger: "line" });
    return [put(base, { q: decision.resend ? "waiting" : "empty" })];
  };

  // J28, J29 엔진이 턴을 끝낸다, 한도에 걸린다 (M:478-486).
  const engineFinish = (life: "ended" | "ended_l"): StepFn => (g) => {
    if (g.p !== "up" || g.life !== "running") return [];
    if (d.runnerLifecycle("running", "finish_completed", true) !== "apply") {
      throw new Error("engine finish rejected by the lifecycle");
    }
    return [put(g, { life, tail: "dirty" })];
  };

  // J31 러너 프로세스가 죽는다 (M:488-498). 넘기던 참의 지시는 decideNodeInstruction이 모름으로 처분한다.
  const runnerDies: StepFn = (g) => {
    if (g.p !== "up") return [];
    const outs = [put(g, { p: "dead", q: loseHandover(g, "J31"), ...CUT2 })];
    if (g.q === "handing" && g.d2.includes("HAND") && g.life === "running") {
      // 러너가 지시를 받아 엔진에 넘기던 참에 죽었다: 들어갔는지 아무도 모른다.
      const decision = d.nodeInstruction({ verdict: "unknown", ledger: "line" });
      if (decision.resend) counters.dupHandover.add(`${keyOf(g)}#J31`);
      else outs.push(put(g, { p: "dead", q: "unknown", ...CUT2 }));
    }
    return outs;
  };

  // J32 러너와의 소켓이 끊긴다 (M:500-503).
  const socketDrops: StepFn = (g) => (g.l2 === "up" ? [put(g, { q: loseHandover(g, "J32"), ...CUT2 })] : []);

  // J33 러너에 다시 붙는다 (M:505-509).
  const socketBack: StepFn = (g) =>
    g.l2 === "down" && g.p === "up" && (g.ex === "turn" || g.ex === "stopping") ? [put(g, { l2: "up" })] : [];

  // J20 서버와의 연결이 끊긴다 (M:511-512).
  const disconnect: StepFn = (g) => (CONNECTED.has(g.L) ? [put(g, { L: "grace" })] : []);

  // J21 유예가 지난다 (M:514-519). 어긋남 2 (d2): 시작 중 세션도 끊김 중단으로 적는다.
  const graceExpires: StepFn = (g) => {
    if (g.L !== "grace") return [];
    if (RUNNING.has(g.S) || g.S === "init") return [put(g, { L: "lost", S: "cut" })];
    return [put(g, { L: "lost" })];
  };

  // J22 서버에 다시 붙는다 (M:521-522).
  const reconnect: StepFn = (g) =>
    g.L === "grace" || g.L === "lost" || g.L === "notimer" ? [put(g, { L: "unrep" })] : [];

  // 목록이 되살리기만 한다 (M:524-536). 셋째 판에 목록 응답의 사유(listreason) 없음.
  const reviveOnly = (g: G, base: G): G => {
    if (UNREC.has(g.S) && inList(g) && g.wt === "free") {
      const registered = g.p !== "none" || ["turn", "stopping", "replay", "adopt_w"].includes(g.ex);
      return put(base, { S: registered ? "run_reg" : "relaunch" });
    }
    return base;
  };

  // J23 서버가 청한 목록이 닿는다 (M:538-546).
  const sendList: StepFn = (g) => {
    if (g.L !== "unrep" && g.L !== "half") return [];
    const base = put(g, { L: "on" });
    if (UNREC.has(g.S)) return [reviveOnly(g, base)];
    if (ACTIVE.has(g.S) && !inList(g)) return [put(base, { S: "cut" })];
    return [base];
  };

  // J39 노드가 스스로 보낸 목록이 닿는다 (M:548-551). I8 (watch): 감시를 끄지 않는다.
  const selfList: StepFn = (g) => (g.L !== "unrep" ? [] : [reviveOnly(g, g)]);

  // J24 여러 번 청해도 목록이 안 온다 (M:553-558).
  const listGiveup: StepFn = (g) => {
    if (g.L === "unrep") return [put(g, { L: "giveup" })];
    if (g.L === "half") return [put(g, { L: "on" })];
    return [];
  };

  // J25 노드가 상태를 다시 알린다 (M:560-561).
  const nodeReports: StepFn = (g) => (g.L === "giveup" ? [put(g, { L: "unrep" })] : []);

  // J36 orch가 재시작한다 (M:563-567). C3: 시작 중 세션만 있는 노드에도 유예 시계를 건다.
  const orchRestart: StepFn = (g) => {
    if (g.L === "lost" || g.L === "notimer") return [];
    return [put(g, { L: RUNNING.has(g.S) || g.S === "init" ? "grace" : "notimer" })];
  };

  // J37 다른 세션이 워크트리를 차지한다 (M:569-574).
  const wtTaken: StepFn = (g) => {
    if (g.wt !== "free" || ACTIVE.has(g.S)) return [];
    if (g.p === "up" && g.life === "held") counters.heldTaken.add(keyOf(g));
    return [put(g, { wt: "occ" })];
  };

  // J38 워크트리가 풀린다 (M:576-577).
  const wtFreed: StepFn = (g) => (g.wt === "occ" ? [put(g, { wt: "free" })] : []);

  // J18 사람이 한도 재개를 예약한다 (M:291-294).
  const humanArm: StepFn = (g) => (LIMITISH.has(g.S) && g.W !== "armed" ? [put(g, { W: "armed" })] : []);

  return {
    J18: humanArm, J19: deliver, J20: disconnect, J21: graceExpires, J22: reconnect, J23: sendList,
    J24: listGiveup, J25: nodeReports, J26: runnerFrame, J27: nodeFrame,
    J28: engineFinish("ended"), J29: engineFinish("ended_l"), J31: runnerDies, J32: socketDrops,
    J33: socketBack, J34: reorder, J35: permReject, J36: orchRestart, J37: wtTaken, J38: wtFreed, J39: selfList,
  };
}

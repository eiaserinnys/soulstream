/**
 * 합친 훑기: 걸음 목록, 넓이 우선 훑기, 길 판정, 약속 술어(카드 #1266 U5c).
 * 원본 M:579-622(걸음), M:630-655(훑기), M:658-676(경로), M:678-705(길 판정), M:712-739(약속), M:742-770(셈).
 */
import { createContext, newCounters, type WorldOptions } from "./world_context.js";
import { channelSteps } from "./world_channel_steps.js";
import { nodeSteps, type StepFn } from "./world_node_steps.js";
import {
  ACTIVE,
  INITIAL,
  LIMITISH,
  MSG_NAMES,
  RECORDED,
  TERMINAL_LIFE,
  baseMsg,
  keyOf,
  type G,
} from "./world_state.js";

export type StepKind = "human" | "system" | "env" | "time" | "engine";

export interface Step {
  id: string;
  label: string;
  kind: StepKind;
  side: string;
  fn: StepFn;
}

/** 걸음 목록이다(M:579-622). 순서도 M과 같다. */
const STEP_TABLE: readonly (readonly [string, string, StepKind, string])[] = [
  ["J01", "지시가 온다", "human", "노드"],
  ["J02", "쌓인 지시로 다시 띄운다", "system", "노드"],
  ["J03", "러너가 뜬다", "system", "노드"],
  ["J04", "다음 턴이 쌓인 지시를 가져간다", "system", "노드"],
  ["J05", "노드가 러너의 끝남을 안다", "system", "노드"],
  ["J06", "실행 명령을 다시 보낸다", "system", "노드"],
  ["J07", "사람이 멈춘다", "human", "노드"],
  ["J08", "멈춤이 정리된다", "system", "노드"],
  ["J09", "띄우기에 실패한다 [다시 해 볼 만한 실패]", "env", "노드"],
  ["J10", "띄우기에 실패한다 [고쳐지지 않을 실패]", "env", "노드"],
  ["J11", "노드가 러너의 죽음을 안다", "system", "노드"],
  ["J13", "러너의 남은 기록이 서버에 다 닿는다", "system", "노드"],
  ["J14", "노드가 재시작한다", "env", "노드"],
  ["J15", "복구 훑기가 돈다", "system", "노드"],
  ["J16", "끊긴 채 응답을 기다리다 시간이 넘는다", "time", "노드"],
  ["J17", "한도가 풀려 예약 시각이 된다", "time", "노드"],
  ["J18", "사람이 한도 재개를 예약한다", "human", "서버"],
  ["J19", "통로 하나의 맨 앞 사건이 서버에 닿는다", "system", "통로 하나"],
  ["J20", "서버와의 연결이 끊긴다", "env", "연결"],
  ["J21", "유예가 지난다", "time", "연결"],
  ["J22", "서버에 다시 붙는다", "env", "연결"],
  ["J23", "서버가 청한 목록이 닿는다", "system", "통로 하나"],
  ["J24", "여러 번 청해도 목록이 안 온다", "time", "연결"],
  ["J25", "노드가 상태를 다시 알린다", "system", "연결"],
  ["J26", "러너가 명령을 받는다", "system", "통로 둘"],
  ["J27", "노드가 러너의 결과를 받는다", "system", "통로 둘"],
  ["J28", "엔진이 턴을 끝낸다", "engine", "러너"],
  ["J29", "엔진이 한도에 걸린다", "engine", "러너"],
  ["J31", "러너 프로세스가 죽는다", "env", "러너"],
  ["J32", "러너와의 소켓이 끊긴다", "env", "통로 둘"],
  ["J33", "러너에 다시 붙는다", "system", "통로 둘"],
  ["J34", "맨 앞 사건이 한 번 실패해 뒤 사건이 먼저 적용된다", "env", "통로 하나"],
  ["J35", "맨 앞 사건이 영구 거절된다", "env", "통로 하나"],
  ["J36", "orch가 재시작한다", "env", "서버"],
  ["J37", "다른 세션이 워크트리를 차지한다", "env", "서버"],
  ["J38", "워크트리가 풀린다", "env", "서버"],
  ["J39", "노드가 스스로 보낸 목록이 닿는다", "system", "통로 하나"],
  ["J41", "종료 정리가 러너를 닫는다 (또는 정상 보유로 둔다)", "system", "노드"],
  ["J42", "종료 정리가 완료 전달을 등록한다", "system", "노드"],
  ["J43", "정상 보유가 풀린다", "engine", "러너"],
  ["J45", "주기 중앙 확인이 잇기를 보낸다", "system", "노드"],
  ["J44", "노드가 미결로 남은 완료 정산을 마친다", "system", "노드"],
];

export const STEP_IDS: readonly string[] = STEP_TABLE.map(([id]) => id);

/** 셋째 판의 안에서 일어날 수 없는 걸음과 그 까닭이다. */
export const STEPS_DISABLED_BY_FIX: Readonly<Record<string, string>> = {
  J34: "I1(hol): 같은 세션의 머리 사건이 실패하면 뒤 사건을 적용하지 않는다",
};

export interface World {
  steps: Step[];
  counters: ReturnType<typeof newCounters>;
}

export function buildWorld(options: WorldOptions): World {
  const counters = newCounters();
  const ctx = createContext(options, counters);
  const fns: Record<string, StepFn> = { ...nodeSteps(ctx), ...channelSteps(ctx) };
  const steps = STEP_TABLE
    .filter(([id]) => !options.envOff.has(id))
    .map(([id, label, kind, side]) => {
      const fn = fns[id];
      if (!fn) throw new Error(`step function missing: ${id}`);
      return { id, label, kind, side, fn };
    });
  return { steps, counters };
}

/** 스스로 하는 일(M:625-627): system, time, 엔진, 그리고 끊긴 연결이 다시 붙는 것(J22). */
function isSelf(step: Step): boolean {
  return step.kind === "system" || step.kind === "time" || step.kind === "engine" || step.id === "J22";
}

export interface Exploration {
  order: G[];
  index: Map<string, number>;
  /** 처음 닿은 부모와 걸음이다. 넓이 우선이라 처음 닿은 길이 최단 경로다. */
  parent: (readonly [number, Step] | null)[];
  /** 스스로 하는 걸음의 다음 구성 색인과 엔진 걸음 여부다. */
  selfEdges: [number, boolean][][];
  /** 걸음별로 구성을 바꾼 횟수다. */
  used: Map<string, number>;
  /** J35를 한 번도 거치지 않고 닿는 구성인가. */
  withoutPermReject: boolean[];
}

/** 넓이 우선 훑기(M:630-655). */
export function explore(steps: readonly Step[]): Exploration {
  const index = new Map<string, number>([[keyOf(INITIAL), 0]]);
  const order: G[] = [INITIAL];
  const parent: (readonly [number, Step] | null)[] = [null];
  const selfEdges: [number, boolean][][] = [[]];
  const used = new Map<string, number>(steps.map((s) => [s.id, 0]));
  const flags = steps.map((s) => [isSelf(s), s.kind === "engine"] as const);
  for (let i = 0; i < order.length; i += 1) {
    const g = order[i]!;
    const gKey = keyOf(g);
    steps.forEach((step, n) => {
      for (const next of step.fn(g)) {
        const nKey = keyOf(next);
        if (nKey === gKey) continue;
        used.set(step.id, used.get(step.id)! + 1);
        let j = index.get(nKey);
        if (j === undefined) {
          j = order.length;
          index.set(nKey, j);
          order.push(next);
          parent.push([i, step]);
          selfEdges.push([]);
        }
        const [self, engine] = flags[n]!;
        if (self) selfEdges[i]!.push([j, engine]);
      }
    });
  }
  return { order, index, parent, selfEdges, used, withoutPermReject: reachableWithout(steps, order, index, "J35") };
}

/** 한 걸음을 빼고 처음 구성에서 닿는 구성을 표시한다. 걸음은 다시 부르지만 판정은 캐시가 받는다. */
function reachableWithout(steps: readonly Step[], order: G[], index: Map<string, number>, skip: string): boolean[] {
  const seen = new Array<boolean>(order.length).fill(false);
  seen[0] = true;
  const queue = [0];
  for (let head = 0; head < queue.length; head += 1) {
    const g = order[queue[head]!]!;
    for (const step of steps) {
      if (step.id === skip) continue;
      for (const next of step.fn(g)) {
        const j = index.get(keyOf(next));
        if (j === undefined) throw new Error("sub-exploration left the explored set");
        if (!seen[j]) {
          seen[j] = true;
          queue.push(j);
        }
      }
    }
  }
  return seen;
}

/** 경로를 사람이 읽는 걸음 이름으로 낸다(M:658-676). */
export function pathTo(exp: Exploration, i: number): string[] {
  const steps: string[] = [];
  let at = i;
  for (let link = exp.parent[at]; link; link = exp.parent[at]) {
    const [prev, step] = link;
    const before = exp.order[prev]!;
    let label = step.label;
    if (step.id === "J19" || step.id === "J35") {
      const m = before.ch[0]!;
      const verb = step.id === "J19" ? "서버에 닿는다" : "영구 거절된다";
      label = `「${MSG_NAMES[baseMsg(m)]}」이 ${verb}${m.endsWith("~") ? " (노드는 더 기다리지 않음)" : ""}`;
    } else if (step.id === "J26") {
      label = ({ EXEC: "러너가 실행 명령을 받는다", INT: "러너가 멈춤 명령을 받는다", HAND: "러너가 넘겨받은 지시를 엔진에 넣는다" } as const)[before.d2[0]!];
    }
    steps.push(`${step.id} ${label}`);
    at = prev;
  }
  return ["세션을 만든다", ...steps.reverse()];
}

/**
 * 길 판정(M:678-705). 돌려주는 값: [길이 없는 구성, 공정해도 못 닿을 수 있는 구성]. 둘 다 concerned 안의 색인이다.
 * 길 없음: 스스로 하는 걸음으로 목표에 못 닿는다. 공정 위반: 스스로 하는 걸음으로 길 없는 구성에 빠질 수 있다.
 */
export function liveness(
  exp: Exploration,
  concerned: (g: G) => boolean,
  goal: (g: G) => boolean,
  engine: boolean,
): [number[], number[]] {
  const n = exp.order.length;
  const isGoal = exp.order.map(goal);
  const rev: number[][] = Array.from({ length: n }, () => []);
  exp.selfEdges.forEach((outs, i) => {
    for (const [j, isEngine] of outs) if (engine || !isEngine) rev[j]!.push(i);
  });
  const backward = (seed: boolean[], stopAtGoal: boolean): boolean[] => {
    const mark = [...seed];
    const queue = mark.flatMap((m, i) => (m ? [i] : []));
    for (let head = 0; head < queue.length; head += 1) {
      for (const i of rev[queue[head]!]!) {
        if (!mark[i] && !(stopAtGoal && isGoal[i])) {
          mark[i] = true;
          queue.push(i);
        }
      }
    }
    return mark;
  };
  const good = backward(isGoal, false);
  const doomed = good.map((x) => !x);
  const fairBad = backward(doomed, true);
  const nopath: number[] = [];
  const unfair: number[] = [];
  exp.order.forEach((g, i) => {
    if (!concerned(g)) return;
    if (doomed[i]) nopath.push(i);
    if (fairBad[i]) unfair.push(i);
  });
  return [nopath, unfair];
}

/** 안전 약속(M:712-721). 술어는 깨진 구성이다. */
export const SAFETY: Readonly<Record<string, readonly [string, (g: G) => boolean]>> = {
  "2": ["한도로 끝나 예약이 걸린 세션은 한도가 풀리면 깨어난다", (g) => LIMITISH.has(g.S) && g.W === "skipped"],
  "4": ["노드가 끊김으로 확정되면 그 노드에 도는 중인 세션이 없다", (g) => g.L === "lost" && ACTIVE.has(g.S)],
  "4b": ["끊긴 노드의 도는 중인 세션에는 유예 시계가 걸려 있다 (orch 재시작 뒤)", (g) => g.L === "notimer" && ACTIVE.has(g.S)],
  "5": ["실제로 끝난 턴의 끝남은 세션 줄에 적힌다 (묻힌 끝남이 없다)", (g) => g.S === "buried"],
};

/** 길 약속(M:722-739): [이름, 걸린 구성, 목표, 엔진 걸음을 스스로 하는 일로 셈]. */
export const LIVENESS: Readonly<Record<string, readonly [string, (g: G) => boolean, (g: G) => boolean, boolean]>> = {
  "7": [
    "서버가 도는 중으로 적었는데 노드에 주인도 러너도 없는 세션은 닫히거나 다시 맡아진다",
    (g) => ACTIVE.has(g.S) && g.ex === "idle" && g.p === "none",
    (g) => !(ACTIVE.has(g.S) && g.ex === "idle" && g.p === "none"),
    true,
  ],
  "9": ["알림이 필요한 종료가 서버에 적히면 완료 전달이 등록된다", (g) => g.nt === "due", (g) => g.nt !== "due", true],
  "12": [
    "러너가 적은 끝남은 서버의 종료 기록에 닿는다 (강한 판정)",
    (g) => TERMINAL_LIFE.has(g.life) && g.p !== "none" && !RECORDED.has(g.S),
    (g) => RECORDED.has(g.S),
    true,
  ],
  "13": [
    "받은 지시는 적용, 반환, 모름 가운데 하나로 끝난다",
    (g) => g.q === "waiting" || g.q === "handing" || g.q === "lost",
    (g) => g.q === "empty" || g.q === "blocked" || g.q === "unknown",
    true,
  ],
  "14": [
    "서버가 끝남으로 아는 세션의 도는 러너는 되살려지거나 거둬진다",
    (g) => !ACTIVE.has(g.S) && g.p === "up" && g.life === "running",
    (g) => ACTIVE.has(g.S) || !(g.p === "up" && g.life === "running"),
    false,
  ],
  "15": ["받아들인 사람의 멈춤은 세션의 종료 기록으로 닫힌다", (g) => g.st === "req", (g) => g.st !== "req", true],
};

export interface PromiseResult {
  count: number;
  /** 위반 구성 하나의 최단 경로다. 위반이 없으면 null. */
  example: string[] | null;
}

export interface SweepResult {
  configs: number;
  safety: Record<string, PromiseResult>;
  path: Record<string, PromiseResult>;
  fair: Record<string, PromiseResult>;
  steps: { dupHandover: number; vanishedStop: number; republishedEnd: number; heldRunnerUnderOccupiedWorktree: number };
  used: Record<string, number>;
  /** 약속 15의 길 없음 구성 가운데 J35를 거치지 않고 닿는 구성 수다. */
  p15WithoutPermReject: number;
  /** 약속 15의 공정 위반 구성 가운데 J35를 거치지 않고 닿는 구성 수다. */
  p15FairWithoutPermReject: number;
  elapsedMs: number;
}

const result = (exp: Exploration, hits: number[]): PromiseResult => ({
  count: hits.length,
  example: hits.length > 0 ? pathTo(exp, Math.min(...hits)) : null,
});

/** 훑고 약속을 잰다(M:742-770). */
export function analyze(options: WorldOptions): SweepResult {
  const started = performance.now();
  const world = buildWorld(options);
  const exp = explore(world.steps);
  const safety: Record<string, PromiseResult> = {};
  for (const [id, [, bad]] of Object.entries(SAFETY)) {
    safety[id] = result(exp, exp.order.flatMap((g, i) => (bad(g) ? [i] : [])));
  }
  const path: Record<string, PromiseResult> = {};
  const fair: Record<string, PromiseResult> = {};
  let p15WithoutPermReject = 0;
  let p15FairWithoutPermReject = 0;
  for (const [id, [, concerned, goal, engine]] of Object.entries(LIVENESS)) {
    const [nopath, unfair] = liveness(exp, concerned, goal, engine);
    path[id] = result(exp, nopath);
    fair[id] = result(exp, unfair);
    if (id === "15") {
      p15WithoutPermReject = nopath.filter((i) => exp.withoutPermReject[i]).length;
      p15FairWithoutPermReject = unfair.filter((i) => exp.withoutPermReject[i]).length;
    }
  }
  const { counters } = world;
  return {
    configs: exp.order.length,
    safety,
    path,
    fair,
    steps: {
      dupHandover: counters.dupHandover.size,
      vanishedStop: counters.vanishedStop.size,
      republishedEnd: counters.republishedEnd.size,
      heldRunnerUnderOccupiedWorktree: counters.heldTaken.size,
    },
    used: Object.fromEntries(exp.used),
    p15WithoutPermReject,
    p15FairWithoutPermReject,
    elapsedMs: Math.round(performance.now() - started),
  };
}

/** 위반 수만 꺼낸다. */
export function counts(r: SweepResult): Record<string, number> {
  const out: Record<string, number> = { configs: r.configs };
  for (const [id, v] of Object.entries(r.safety)) out[`safety ${id}`] = v.count;
  for (const [id, v] of Object.entries(r.path)) out[`path ${id}`] = v.count;
  for (const [id, v] of Object.entries(r.fair)) out[`fair ${id}`] = v.count;
  out.dupHandover = r.steps.dupHandover;
  out.vanishedStop = r.steps.vanishedStop;
  return out;
}

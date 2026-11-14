/**
 * 합친 훑기의 구성과 값 범위다(카드 #1266 U5c).
 *
 * 원본은 카드 #1218 합의의 파이썬 손 모형 fable_r2_machine.py(이하 M)다. 줄 번호는 그 파일의 것이다.
 * 합친 상태 G = (S, W, L, ch, ex, q, p, life, tail, l2, d2, u2, wt, nt, st) (M:6-11, M:41-56).
 * 운영 코드는 이 폴더를 부르지 않는다. 시험 폴더 아래에 두어 빌드에 들어가지 않는다.
 */

/** 서버의 세션 줄이다(M:62-79). */
export type ServerState =
  | "init"
  | "relaunch"
  | "relaunch_l"
  | "run_reg"
  | "ended"
  | "limit"
  | "limit_copy"
  | "end_copy"
  | "cut"
  | "buried";

/** 한도 재개 예약이다. */
export type WakeState = "none" | "armed" | "stale" | "skipped";

/** 노드와 서버 사이 연결이다. */
export type LinkState = "on" | "unrep" | "giveup" | "half" | "grace" | "lost" | "notimer";

/** 노드의 실행이다. */
export type NodeExec =
  | "gate"
  | "resume_w"
  | "reg_w"
  | "turn"
  | "stopping"
  | "replay"
  | "adopt_w"
  | "end_w"
  | "copy_w"
  | "fin1"
  | "fin2"
  | "idle";

/** 받은 지시다. */
export type Instruction = "empty" | "waiting" | "handing" | "blocked" | "lost" | "unknown";

export type RunnerProcess = "none" | "up" | "dead";
export type RunnerLife = "none" | "running" | "ended" | "ended_l" | "reaped" | "held";

export interface G {
  S: ServerState;
  W: WakeState;
  L: LinkState;
  /** 통로 하나의 사건 줄이다. 끝에 ~가 붙으면 노드가 그 응답을 더 기다리지 않는다. */
  ch: readonly string[];
  ex: NodeExec;
  q: Instruction;
  p: RunnerProcess;
  life: RunnerLife;
  tail: "clean" | "dirty";
  l2: "up" | "down";
  d2: readonly ("EXEC" | "INT" | "HAND")[];
  u2: readonly ("H_OK" | "H_NO")[];
  wt: "free" | "occ";
  /** 완료 전달 의무. */
  nt: "-" | "due";
  /** 사람의 멈춤이 받아들여졌고 아직 닫히지 않았다. */
  st: "-" | "req";
}

export const MSG_NAMES: Readonly<Record<string, string>> = {
  RESUME: "다시 띄움 알림",
  ADOPT: "러너를 잇겠다는 알림",
  REG: "실행 등록",
  T_END: "종료 (완료, 오류)",
  T_STOP: "종료 (사람의 멈춤)",
  T_LIMIT: "종료 (한도)",
  T_COPY: "되돌림 (이전 끝남을 베낌)",
};

export const TERMS = new Set(["T_END", "T_STOP", "T_LIMIT"]);
export const WAITING: Readonly<Partial<Record<NodeExec, string>>> = {
  resume_w: "RESUME",
  reg_w: "REG",
  end_w: "T",
  copy_w: "T_COPY",
  adopt_w: "ADOPT",
};
export const NODE_RUNNING = new Set<NodeExec>(["gate", "reg_w", "turn", "stopping", "replay", "adopt_w"]);
export const CONNECTED = new Set<LinkState>(["on", "unrep", "giveup", "half"]);
export const ACTIVE = new Set<ServerState>(["init", "relaunch", "relaunch_l", "run_reg"]);
export const RUNNING = new Set<ServerState>(["relaunch", "relaunch_l", "run_reg"]);
export const RECORDED = new Set<ServerState>(["ended", "limit", "limit_copy", "end_copy"]);
export const UNREC = new Set<ServerState>(["cut", "buried"]);
export const LIMITISH = new Set<ServerState>(["limit", "limit_copy"]);
/** M:74은 closed도 넣지만 M의 걸음은 closed를 만들지 않는다(design.md 「후보 바」). */
export const TERMINAL_LIFE = new Set<RunnerLife>(["ended", "ended_l", "reaped"]);

export const INITIAL: G = {
  S: "init", W: "none", L: "on", ch: [], ex: "gate", q: "empty", p: "none", life: "none",
  tail: "clean", l2: "down", d2: [], u2: [], wt: "free", nt: "-", st: "-",
};

/** 러너가 없는 꼴이다(M:77). */
export const NO_RUNNER = { p: "none", life: "none", tail: "clean", l2: "down", d2: [], u2: [] } as const satisfies Partial<G>;
/** 러너와의 소켓이 끊긴 꼴이다(M:78). */
export const CUT2 = { l2: "down", d2: [], u2: [] } as const satisfies Partial<G>;

export function keyOf(g: G): string {
  return [
    g.S, g.W, g.L, g.ch.join(","), g.ex, g.q, g.p, g.life, g.tail, g.l2,
    g.d2.join(","), g.u2.join(","), g.wt, g.nt, g.st,
  ].join("|");
}

export function put(g: G, changes: Partial<G>): G {
  return { ...g, ...changes };
}

export function conn(g: G): boolean {
  return CONNECTED.has(g.L);
}

export function baseMsg(m: string): string {
  return m.replace(/~+$/, "");
}

export function stale(ch: readonly string[]): string[] {
  return ch.map((m) => (m.endsWith("~") ? m : `${m}~`));
}

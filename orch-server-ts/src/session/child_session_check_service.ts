import type { NodeRegistryEvent } from "../node/registry_types.js";
import type {
  ChildSessionCheckEvent,
  ChildSessionCheckStore,
  ChildSessionCheckTarget,
  ChildSessionCheckToolStart,
} from "./child_session_check_repository.js";

export type {
  ChildSessionCheckEvent,
  ChildSessionCheckExistingDelivery,
  ChildSessionCheckStore,
  ChildSessionCheckTarget,
  ChildSessionCheckToolStart,
} from "./child_session_check_repository.js";

/** 유효 응답 뒤 이만큼 조용하면 확인을 보낸다. 설정 옵션은 두지 않는다. */
export const CHILD_SESSION_CHECK_THRESHOLD_MS = 300_000;
export const CHILD_SESSION_CHECK_MAX_PER_CHECK = 10;
export const CHILD_SESSION_CHECK_SOURCE = "child_session_check";

const LIVE_TEXT_EVENT_TYPES = new Set(["text_start", "text_delta", "text_end"]);
const COMMAND_PREVIEW_CHARS = 120;
const ERROR_SUMMARY_CHARS = 120;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export type ChildSessionCheckNodeState = {
  readonly connected: boolean;
  readonly runningSessionIds?: ReadonlySet<string>;
};

export type ChildSessionCheckDelivery = {
  readonly callerSessionId: string;
  readonly childSessionId: string;
  readonly deliveryId: string;
  readonly text: string;
};

export type ChildSessionCheckServiceOptions = {
  readonly store: ChildSessionCheckStore;
  readonly deliver: (input: ChildSessionCheckDelivery) => Promise<void>;
  readonly nodeState?: (nodeId: string) => ChildSessionCheckNodeState | undefined;
  readonly warn?: (message: string) => void;
  readonly nowMs?: () => number;
};

type LiveRecord = {
  readonly atMs: number;
  readonly kind: string;
};

type Candidate = {
  readonly target: ChildSessionCheckTarget;
  readonly lastValidAtMs: number;
  readonly lastValidEventId: number | null;
  readonly lastValidEventType: string | null;
  readonly live: LiveRecord | undefined;
};

/**
 * 진행 중인 하위 세션이 유효 응답 없이 5분을 넘겼는지 60초 주기로 확인하고,
 * 담당 세션에 한 번씩 알린다. 실시간 text 이벤트는 DB에 없으므로 노드 이벤트 sink에서
 * 세션별 마지막 수신 시각과 종류만 메모리에 모아 판정에 쓴다.
 */
export class ChildSessionCheckService {
  private readonly live = new Map<string, LiveRecord>();
  private readonly nowMs: () => number;

  constructor(private readonly options: ChildSessionCheckServiceOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** 노드 이벤트 sink. 저장되지 않는 text_start/text_delta/text_end만 받아 기록한다. */
  acceptNodeEvents(events: readonly NodeRegistryEvent[]): void {
    const atMs = this.nowMs();
    for (const event of events) {
      if (event.type !== "node_session_event") continue;
      const data = event.data;
      if (data.type !== "event") continue;
      const payload = isRecord(data.event) ? data.event : undefined;
      const kind = payload !== undefined && typeof payload.type === "string" ? payload.type : undefined;
      if (kind === undefined || !LIVE_TEXT_EVENT_TYPES.has(kind)) continue;
      const sessionId = sessionIdFromEnvelope(data, payload);
      if (sessionId === null) continue;
      this.live.set(sessionId, { atMs, kind });
    }
  }

  async checkOnce(): Promise<void> {
    const nowMs = this.nowMs();
    const targets = await this.options.store.listTargets();
    this.pruneLive(targets);

    const candidates = targets
      .map((target) => this.candidate(target))
      .filter((candidate) => nowMs - candidate.lastValidAtMs > CHILD_SESSION_CHECK_THRESHOLD_MS)
      .sort((left, right) =>
        left.lastValidAtMs - right.lastValidAtMs
        || left.target.childSessionId.localeCompare(right.target.childSessionId));

    let attempts = 0;
    for (const candidate of candidates) {
      if (attempts >= CHILD_SESSION_CHECK_MAX_PER_CHECK) return;
      if (await this.alreadyRegistered(candidate)) continue;
      attempts += 1;
      try {
        const text = await this.buildMessage(candidate, nowMs);
        await this.options.deliver({
          callerSessionId: candidate.target.callerSessionId,
          childSessionId: candidate.target.childSessionId,
          deliveryId: deliveryIdFor(candidate),
          text,
        });
      } catch (error) {
        this.options.warn?.(
          `child session check delivery failed for ${candidate.target.childSessionId}: ${messageOf(error)}`,
        );
      }
    }
  }

  private candidate(target: ChildSessionCheckTarget): Candidate {
    const live = this.live.get(target.childSessionId);
    const dbAtMs = target.lastValidEventAtMs;
    const liveWins = live !== undefined && (dbAtMs === null || live.atMs > dbAtMs);
    return {
      target,
      lastValidAtMs: liveWins ? live.atMs : dbAtMs ?? target.sessionCreatedAtMs,
      lastValidEventId: liveWins ? null : target.lastValidEventId,
      lastValidEventType: liveWins ? live.kind : target.lastValidEventType,
      live: liveWins ? live : undefined,
    };
  }

  /** 이미 보낸 전달이면 등록하지 않는다. 재시작으로 실시간 기록을 잃어 token이 바뀌어도 중복이 없다. */
  private async alreadyRegistered(candidate: Candidate): Promise<boolean> {
    if (await this.options.store.deliveryExists(deliveryIdFor(candidate))) return true;
    const existing = await this.options.store.findCheckDeliveries({
      childSessionId: candidate.target.childSessionId,
      callerSessionId: candidate.target.callerSessionId,
    });
    return existing.some((delivery) => delivery.createdAtMs > candidate.lastValidAtMs);
  }

  private pruneLive(targets: readonly ChildSessionCheckTarget[]): void {
    const active = new Set(targets.map((target) => target.childSessionId));
    for (const sessionId of this.live.keys()) {
      if (!active.has(sessionId)) this.live.delete(sessionId);
    }
  }

  private async buildMessage(candidate: Candidate, nowMs: number): Promise<string> {
    const sessionId = candidate.target.childSessionId;
    const [latestEvent, toolStarts, lastError] = await Promise.all([
      this.options.store.latestEvent(sessionId),
      this.options.store.openToolStarts(sessionId),
      this.options.store.lastError(sessionId),
    ]);
    return renderMessage({
      candidate,
      nowMs,
      latestEvent,
      toolStarts,
      lastError,
      nodeState: candidate.target.nodeId === null
        ? undefined
        : this.options.nodeState?.(candidate.target.nodeId),
    });
  }
}

function deliveryIdFor(candidate: Candidate): string {
  const token = candidate.live !== undefined
    ? `live:${candidate.live.atMs}`
    : candidate.lastValidEventId !== null
      ? `event:${candidate.lastValidEventId}`
      : "initial";
  return `child-check:${candidate.target.childSessionId}:${candidate.target.callerSessionId}:${token}`;
}

type RenderInput = {
  readonly candidate: Candidate;
  readonly nowMs: number;
  readonly latestEvent: ChildSessionCheckEvent | null;
  readonly toolStarts: readonly ChildSessionCheckToolStart[];
  readonly lastError: ChildSessionCheckEvent | null;
  readonly nodeState: ChildSessionCheckNodeState | undefined;
};

function renderMessage(input: RenderInput): string {
  const { candidate, nowMs } = input;
  const target = candidate.target;
  const elapsedMinutes = ((nowMs - candidate.lastValidAtMs) / 60_000).toFixed(1);
  const validLine = candidate.lastValidEventId === null && candidate.live === undefined
    ? "마지막 유효 응답: 없음"
    : `마지막 유효 응답: ${formatKst(candidate.lastValidAtMs)} (${candidate.lastValidEventType ?? "미확인"})`;
  const lastReceived = lastReceivedLine(input.latestEvent, candidate.live);
  const verdict = candidate.live !== undefined
    ? "실시간 text 이벤트 수신"
    : candidate.lastValidEventId === null
      ? "유효 응답 없음"
      : "시간을 갱신하지 않는 이벤트(일반 progress, hook 등)";
  const tool = toolStateLines(input.toolStarts);
  return [
    "[하위 세션 확인]",
    "하위 세션에서 5분 이상 유효한 응답이 없습니다. 오래 걸리는 작업을 진행 중인지 확인하세요.",
    "",
    `세션: ${target.displayName ?? "이름 없음"}`,
    `세션 ID: ${target.childSessionId}`,
    `에이전트: ${target.agentId ?? "미확인"}`,
    `프리셋: ${target.modelPreset ?? "미확인"}`,
    "",
    validLine,
    `경과: ${elapsedMinutes}분`,
    "",
    lastReceived,
    `응답 판정: ${verdict}`,
    "",
    ...tool,
    "",
    nodeLine(target, input.nodeState),
    input.lastError === null ? "마지막 오류: 없음" : errorLine(input.lastError),
    `확인 시각: ${formatKst(nowMs)}`,
    "",
    "긴 명령이 도는 중이면 그대로 두고, 멈춘 것으로 보이면 규칙에 따라 같은 세션에 이어서 지시하거나 다른 모델로 넘기세요.",
  ].join("\n");
}

function lastReceivedLine(
  latestEvent: ChildSessionCheckEvent | null,
  live: LiveRecord | undefined,
): string {
  if (live !== undefined && (latestEvent === null || live.atMs > latestEvent.createdAtMs)) {
    return `마지막 수신 이벤트: ${formatKst(live.atMs)} (${live.kind})`;
  }
  if (latestEvent !== null) {
    return `마지막 수신 이벤트: ${formatKst(latestEvent.createdAtMs)} (${latestEvent.eventType})`;
  }
  return "마지막 수신 이벤트: 없음";
}

function toolStateLines(toolStarts: readonly ChildSessionCheckToolStart[]): string[] {
  const pending = toolStarts.filter((tool) => !tool.answered);
  const primary = pending[0];
  if (primary === undefined) {
    return [
      "도구 상태: 결과를 기다리는 도구 시작 기록 없음",
      "도구 이름: 해당 없음",
      "명령 앞부분: 해당 없음",
      "시작 시각: 해당 없음",
    ];
  }
  const state = primary.toolUseId === null
    ? "연결 ID가 없어 미확인"
    : primary.command !== null
      ? "명령 실행 중으로 보임"
      : "도구 결과 대기 중";
  const lines = [
    `도구 상태: ${state}`,
    `도구 이름: ${primary.toolName ?? "미확인"}`,
    `명령 앞부분: ${primary.command === null ? "해당 없음" : truncate(collapse(primary.command), COMMAND_PREVIEW_CHARS)}`,
    `시작 시각: ${formatKst(primary.startedAtMs)}`,
  ];
  if (pending.length > 1) lines.push(`그 밖에 결과를 기다리는 도구 ${pending.length - 1}개`);
  return lines;
}

function nodeLine(
  target: ChildSessionCheckTarget,
  state: ChildSessionCheckNodeState | undefined,
): string {
  const nodeId = target.nodeId ?? "미확인";
  if (state === undefined) {
    return `노드: ${nodeId} 미확인, 노드가 보고한 실행 목록에 보고 없음`;
  }
  const connection = state.connected ? "연결됨" : "연결 끊김";
  const membership = state.runningSessionIds === undefined
    ? "노드가 보고한 실행 목록에 보고 없음"
    : state.runningSessionIds.has(target.childSessionId)
      ? "노드가 보고한 실행 목록에 있음"
      : "노드가 보고한 실행 목록에 없음";
  return `노드: ${nodeId} ${connection}, ${membership}`;
}

function errorLine(event: ChildSessionCheckEvent): string {
  const payload = event.payload ?? {};
  const code = stringOrNull(payload.code);
  const summary = truncate(
    collapse(
      stringOrNull(payload.message)
      ?? stringOrNull(payload.error)
      ?? stringOrNull(payload.text)
      ?? event.eventType,
    ),
    ERROR_SUMMARY_CHARS,
  );
  const meta = code === null ? event.eventType : `${event.eventType}, ${code}`;
  return `마지막 오류: ${formatKst(event.createdAtMs)} (${meta}) ${summary}`;
}

function sessionIdFromEnvelope(
  envelope: Record<string, unknown>,
  event: Record<string, unknown> | undefined,
): string | null {
  for (const source of [envelope, event]) {
    if (source === undefined) continue;
    for (const key of ["agentSessionId", "agent_session_id", "sessionId", "session_id"]) {
      const value = source[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return null;
}

/** Asia/Seoul 고정 표기. 서버 시간대에 의존하지 않는다. */
function formatKst(atMs: number): string {
  const shifted = new Date(atMs + KST_OFFSET_MS).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 19)} +09:00`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

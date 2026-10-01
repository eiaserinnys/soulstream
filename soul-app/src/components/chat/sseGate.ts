// SSE 세션 이벤트 → ChatBody 머지 게이트.
//
// ChatBody.tsx의 useSSEStream onEvent 본문을 그대로 옮긴 함수다.
// 외부 인터페이스로 추출한 이유는 (1) ChatBody 풀 mount는 expo / navigation /
// zustand 스토어 의존성이 막대해 통합 테스트 비용이 합리화되지 않고,
// (2) 게이트의 핵심 동작(catchup 단계의 LayoutAnimation 차단 + historyLoading 중
// 라이브 SSE 큐잉)이 한 곳에 집중되어야 design-principles §3(정본은 하나),
// §10(인터페이스가 테스트 표면)을 모두 만족하기 때문이다.

import type { SessionEvent } from '../../api/types';

export const CATCHUP_REPLAY_CHUNK_SIZE = 50;
const CATCHUP_REPLAY_YIELD_MS = 0;

function asRecord(data: unknown): Record<string, unknown> | null {
  return typeof data === 'object' && data !== null
    ? data as Record<string, unknown>
    : null;
}

function stringField(
  record: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

export function isLiveOnlyPayload(data: unknown): boolean {
  return (
    asRecord(data)?._live_only === true
  );
}

export function isStateOnlySseEventType(type: string): boolean {
  return type.startsWith('claude_runtime_');
}

export function shouldAcceptSessionSsePayload(
  currentSessionId: string,
  data: unknown,
): boolean {
  const record = asRecord(data);
  if (!record) return true;
  const ids = [
    stringField(record, 'agentSessionId'),
    stringField(record, 'agent_session_id'),
    stringField(record, 'session_id'),
  ].filter((value): value is string => value !== null);
  if (ids.length === 0) return true;
  return ids.every((id) => id === currentSessionId);
}

function historySyncLastEventId(data: unknown): string | null {
  const raw = asRecord(data)?.last_event_id;
  const value = typeof raw === 'number' || typeof raw === 'string'
    ? Number(raw)
    : NaN;
  if (!Number.isFinite(value) || value <= 0) return null;
  return String(Math.trunc(value));
}

function historySyncRequiresReset(data: unknown): boolean {
  return asRecord(data)?.reset_required === true;
}

function hashStableString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function liveEventIdentity(record: Record<string, unknown>): string {
  return stringField(
    record,
    'streamIdentity',
    'tool_use_id',
    'item_id',
    'content_block_id',
    'task_id',
    'notification_id',
  ) ?? 'no-item';
}

function liveEventContentKey(record: Record<string, unknown>): string {
  const indexed = stringField(
    record,
    'chunk_index',
    'delta_index',
    'text_index',
    'content_index',
    'sequence',
    'index',
    'offset',
    'liveSeq',
  );
  if (indexed) return `index:${indexed}`;

  // Legacy app-server deltas predate liveSeq, but the producer still stamps
  // each frame. The same payload replay keeps that timestamp; two real chunks
  // with identical text receive different timestamps.
  const timestamp = stringField(record, 'timestamp');
  const text = stringField(record, 'text', 'delta', 'thinking', 'content', 'message');
  const textKey = text ? `text:${hashStableString(text)}` : 'empty';
  return timestamp ? `timestamp:${timestamp}:${textKey}` : textKey;
}

function stableLiveEventId(type: string, data: unknown): string {
  const record = asRecord(data);
  if (!record) return `live:${type}:unknown:no-item:empty`;
  const rawType = stringField(record, 'raw_event_type', 'type') ?? type;
  return [
    'live',
    type,
    rawType,
    liveEventIdentity(record),
    liveEventContentKey(record),
  ].join(':');
}

function payloadEventId(data: unknown, key: '_event_id' | 'id'): string | null {
  const record = asRecord(data);
  if (!record) return null;
  const value = record[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : null;
}

export function createSessionEventFromSse(
  type: string,
  data: unknown,
  eid: string,
  framePhase: SessionSseFramePhase,
): { event: SessionEvent; eventId: string } {
  const liveOnly = isLiveOnlyPayload(data);
  const cursorEventId = liveOnly ? '' : eid;
  // react-native-sse carries the previous Last-Event-ID into frames with no
  // `id:` line. A live-only frame therefore cannot use outer eid as identity:
  // distinct chunks would collapse onto the carried durable cursor. Prefer a
  // committed payload id, otherwise derive identity from stream metadata.
  // During pre-history_sync catch-up, the server writes an explicit `id:` for
  // every durable row, so those ids remain the strongest replay identity.
  const storeEventId = payloadEventId(data, '_event_id')
    || (liveOnly && framePhase === 'live' ? null : eid)
    || payloadEventId(data, 'id')
    || stableLiveEventId(type, data);
  return {
    event: {
      // 7caf0414 may reassert a lower durable event after history_sync without
      // an SSE id. Keep its durable merge identity without advancing the cursor.
      id: storeEventId,
      type: type as SessionEvent['type'],
      data: data as Record<string, unknown>,
    },
    eventId: cursorEventId,
  };
}

export interface SseGateRefs {
  /** Wire phase: history_sync 이전 durable replay / 이후 live. Queue drain과 별개다. */
  framePhaseRef: { current: SessionSseFramePhase };
  /** SSE 재연결 후 history_sync 도착 전까지 true. */
  isCatchingUpRef: { current: boolean };
  /** REST 페이지 로딩 중 true. */
  historyLoadingRef: { current: boolean };
  /**
   * historyLoadingRef=true 동안 도착한 라이브 SSE 이벤트를 적재하는 큐 (F-B).
   * historyLoadingRef가 false로 전환된 직후 ChatBody의 finally 블록이
   * flushQueuedSseEvents를 호출하여 한 번의 mergeEvents로 일괄 머지한다.
   * 이렇게 하면 prepend 페이지 도착(set 1) + 라이브 SSE batch 머지(set 2) 두 set이
   * 직렬화되어 동일 layout pass 안에서 두 변경이 race를 일으키는 영역이 제거된다.
   */
  pendingLiveQueueRef: { current: Array<{ event: SessionEvent; eid: string }> };
  /**
   * SSE open 이후 history_sync 전까지 도착한 replay/catchup 이벤트 큐.
   * catchup 중에는 건별 merge를 금지하고, history_sync 도착 시 chunked batch로
   * ingest하여 JS thread를 장시간 독점하지 않는다.
   */
  pendingCatchupQueueRef: { current: Array<{ event: SessionEvent; eid: string }> };
  /** 세션 전환/재연결 세대. chunked catchup flush의 stale timer를 차단한다. */
  generationRef?: { current: number };
}

export interface SseGateActions {
  /** 새 메시지가 라이브로 도착했음을 시각화 (LayoutAnimation.configureNext 호출). */
  triggerAnimation: () => void;
  /** SessionEvent 한 건을 chatStore에 머지. */
  ingestEvent: (event: SessionEvent) => void;
  /**
   * 큐 flush 시 한 번의 mergeEvents 호출로 N개 이벤트를 일괄 머지한다 (F-B).
   * chatStore.mergeEvents가 배열을 받으므로 자연 매핑.
   */
  ingestEventsBatch: (events: SessionEvent[]) => void;
  /** lastEventId를 chatStore에 기록 — 재연결 catchup 기준점. */
  setLastEventId: (eid: string) => void;
  /** 과대 catchup 대신 기존 콜드 스냅샷 경로를 다시 시작한다. */
  resetToSnapshot?: (baselineCursor: string | null) => void;
  /** durable replay chunk가 모두 commit되고 catchup gate가 열린 직후 호출한다. */
  onCatchupCommitted?: () => void;
  /** 두 번째 이후 비동기 replay chunk commit 실패 시 transport 재연결을 요청한다. */
  onAsyncCommitError?: (error: unknown) => void;
}

export type SessionSseFramePhase = 'replay' | 'live';

/**
 * 단일 SSE 이벤트를 처리한다.
 *
 * - history_sync 마커: catchup 단계 종료 신호. 게이트 ref를 false로 전환하고,
 *   pendingCatchupQueueRef를 chunked batch로 flush한다. 마커 자체는 머지하지 않는다.
 * - historyLoadingRef=true (REST 페이지 로딩 중): 라이브 SSE는 큐에 적재만 한다 (F-B 큐잉).
 *   ingestEvent / setLastEventId / triggerAnimation 모두 발화하지 않는다 — flush 책임.
 * - 그 외 일반 이벤트:
 *   - !isCatchingUp일 때만 entering 애니메이션을 발화.
 *   - chatStore에 머지하고, 서버가 lastEventId를 줬으면 기록한다.
 *
 * 세션 lifecycle(status + reviewState)의 정본은 `/api/sessions/stream`이다.
 * 이 chat SSE 게이트는 catch-up과 live 모두 채팅 트리만 갱신한다.
 */
export function handleSessionSseEvent(
  type: string,
  data: unknown,
  eid: string,
  refs: SseGateRefs,
  actions: SseGateActions,
): void {
  if (type === 'history_sync') {
    // Marker 뒤 wire frame은 catchup queue가 아직 비동기 drain 중이어도 live다.
    refs.framePhaseRef.current = 'live';
    // 서버 catchup 종료 신호. 마커 자체의 도달이 catchup 종료를 의미한다.
    // last_event_id는 SSE id가 없는 baseline cursor다. queue가 모두 store에 commit된 뒤에만
    // 반영하여 chunk flush 도중 비활성 전환이 미커밋 이벤트를 건너뛰지 않게 한다.
    const syncLastEventId = historySyncLastEventId(data);
    if (historySyncRequiresReset(data)) {
      refs.isCatchingUpRef.current = false;
      refs.pendingCatchupQueueRef.current = [];
      refs.pendingLiveQueueRef.current = [];
      // reset boundary는 REST snapshot이 store에 commit된 뒤 호출자가 확정한다.
      actions.resetToSnapshot?.(syncLastEventId);
      return;
    }
    flushQueuedCatchupReplayEvents(refs, actions, syncLastEventId);
    return;
  }
  if (isStateOnlySseEventType(type)) {
    // 상태 payload는 호출자가 먼저 적용하지만, 앞선 chat event가 catchup/history queue에
    // 미커밋 상태일 수 있다. 그 이벤트를 건너뛰는 cursor advance는 금지하고 replay를 허용한다.
    if (
      eid
      && !refs.isCatchingUpRef.current
      && !refs.historyLoadingRef.current
      && refs.pendingLiveQueueRef.current.length === 0
    ) {
      actions.setLastEventId(eid);
    }
    return;
  }
  const { event, eventId } = createSessionEventFromSse(
    type,
    data,
    eid,
    refs.framePhaseRef.current,
  );
  if (refs.isCatchingUpRef.current) {
    refs.pendingCatchupQueueRef.current.push({ event, eid: eventId });
    return;
  }
  // F-B: REST 페이지 로딩 중이면 큐에 적재만. ingestEvent와 setLastEventId는 flush 책임.
  // historyLoading=false 인 prepend 응답 직후 ChatBody finally 블록이 flushQueuedSseEvents 호출
  // → 한 번의 mergeEvents로 batch 머지하여 prepend·라이브 두 set을 직렬화.
  if (refs.historyLoadingRef.current) {
    refs.pendingLiveQueueRef.current.push({ event, eid: eventId });
    return;
  }
  if (refs.pendingLiveQueueRef.current.length > 0) {
    refs.pendingLiveQueueRef.current.push({ event, eid: eventId });
    flushQueuedSseEvents(refs, actions);
    return;
  }
  if (!refs.isCatchingUpRef.current) {
    actions.triggerAnimation();
  }
  actions.ingestEvent(event);
  if (eventId) actions.setLastEventId(eventId);
}

/**
 * historyLoading 동안 큐잉된 라이브 SSE 이벤트들을 한 번에 머지한다 (F-B).
 *
 * ChatBody의 loadHistoryPage finally 블록에서 호출하여
 * prepend 응답 머지(set 1) → catchup된 라이브 batch 머지(set 2) 순서로 직렬화.
 *
 * - 큐가 비어 있으면 no-op.
 * - 비어있지 않으면 한 번의 ingestEventsBatch(events) + 마지막 eid setLastEventId
 *   + 라이브 단계라면 (isCatchingUpRef=false) triggerAnimation 1회.
 *
 * fetch 실패(catch 블록 진입) 시에도 finally는 실행되므로 큐 누수 없음 —
 * loadHistoryPage try/catch/finally가 단일 함수 안에 닫혀있어 보장.
 */
export function flushQueuedSseEvents(
  refs: Pick<SseGateRefs, 'pendingLiveQueueRef' | 'isCatchingUpRef'>,
  actions: Pick<
    SseGateActions,
    'ingestEventsBatch' | 'setLastEventId' | 'triggerAnimation'
  >,
): void {
  const queue = refs.pendingLiveQueueRef.current;
  if (queue.length === 0) return;
  // historyLoading 중 쌓인 queued flush는 layout animation을 발화하지 않는다.
  // live append 한 건 단위 애니메이션은 handleSessionSseEvent의 일반 live 경로가 담당한다.
  actions.ingestEventsBatch(queue.map((q) => q.event));
  refs.pendingLiveQueueRef.current = refs.pendingLiveQueueRef.current.slice(
    queue.length,
  );
  const lastEid = [...queue].reverse().find((q) => q.eid)?.eid;
  if (lastEid) actions.setLastEventId(lastEid);
}

export function flushQueuedCatchupReplayEvents(
  refs: Pick<
    SseGateRefs,
    'pendingCatchupQueueRef' | 'generationRef' | 'isCatchingUpRef'
  >,
  actions: Pick<
    SseGateActions,
    | 'ingestEventsBatch'
    | 'setLastEventId'
    | 'onCatchupCommitted'
    | 'onAsyncCommitError'
  >,
  baselineCursor: string | null = null,
): void {
  const generation = refs.generationRef?.current;

  const flushNextChunk = () => {
    if (
      generation !== undefined &&
      refs.generationRef?.current !== generation
    ) {
      return;
    }
    // history_sync 뒤 같은 EventSource에서 즉시 온 live event도 catchup=true 동안 이 ref에
    // 이어 붙는다. ref 자체를 비우지 않고 splice해야 순서대로 같은 drain에 포함된다.
    const chunk = refs.pendingCatchupQueueRef.current.slice(
      0,
      CATCHUP_REPLAY_CHUNK_SIZE,
    );
    if (chunk.length > 0) {
      actions.ingestEventsBatch(chunk.map((q) => q.event));
      refs.pendingCatchupQueueRef.current.splice(0, chunk.length);
      const lastEid = [...chunk].reverse().find((q) => q.eid)?.eid;
      if (lastEid) actions.setLastEventId(lastEid);
    }
    if (refs.pendingCatchupQueueRef.current.length > 0) {
      setTimeout(() => {
        try {
          flushNextChunk();
        } catch (error) {
          actions.onAsyncCommitError?.(error);
        }
      }, CATCHUP_REPLAY_YIELD_MS);
      return;
    }
    refs.isCatchingUpRef.current = false;
    if (baselineCursor) actions.setLastEventId(baselineCursor);
    actions.onCatchupCommitted?.();
  };

  flushNextChunk();
}

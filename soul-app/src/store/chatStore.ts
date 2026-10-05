// Size exception: one Zustand store keeps its atomic state/action transitions together.
// The independent Claude runtime payload projection lives in claudeRuntimeProjection;
// splitting the remaining single-use transitions would create shallow pass-through modules.
import { create } from 'zustand';
import type {
  ClaudeRuntimeSchedulesResponse,
  ClaudeRuntimeTasksResponse,
  SessionEvent,
} from '../api/types';
import { mergeAppendOnlyStreamingDelta } from '../lib/streamingDeltaEvent';
import { subscribeAuthScope } from '../lib/auth-scope';
import {
  applyClaudeRuntimePayload,
  type ClaudeRuntimeView,
} from './claudeRuntimeProjection';
import {
  invalidateClaudeRuntimeLists,
  noteClaudeRuntimeListEvent,
} from './claudeRuntimeListLifecycleStore';

export type { ClaudeRuntimeView } from './claudeRuntimeProjection';

// optimistic 사용자 메시지의 id prefix. 진짜 서버 이벤트 id는 숫자(또는 SSE의 fallback
// `{type}-{ts}` — sseGate.ts L51 참조)이므로 충돌 없다.
export const OPTIMISTIC_USER_ID_PREFIX = 'optimistic-user-';
export const OPTIMISTIC_AFTER_EVENT_ID_KEY = '__optimisticAfterEventId';

export type PendingOptimisticStatus = 'sending' | 'failed';
export interface PendingOptimisticAttachment {
  path: string;
  name?: string;
}
export interface PendingOptimisticEvent extends SessionEvent {
  /** 일반 초기 프롬프트 낙관 이벤트는 이 값이 없다. */
  pendingStatus?: PendingOptimisticStatus;
  originalText?: string;
  attachmentItems?: PendingOptimisticAttachment[];
  failureReason?: string;
  /** 입력창을 비운 뒤에도 해당 전송의 사용 로그 결과를 연결한다. */
  usageFlowId?: string | null;
}

export type StreamingSlotKind = 'assistant' | 'thinking';
export type PersistentChatDisplaySettings = {
  show_generation_separator: boolean;
  show_jev_candidates: boolean;
};

type PersistentDisplaySettingsState = {
  sessionId: string;
  settings: PersistentChatDisplaySettings | null;
  requestId: number;
};

export interface StreamingSlots {
  /** Legacy/unidentified stream. New v2 events use assistantByStream. */
  assistant?: SessionEvent;
  thinking?: SessionEvent;
  assistantByStream?: Readonly<Record<string, SessionEvent>>;
  /** Active/capped snapshot identities whose raw durable text fragments stay hidden. */
  assistantSnapshotStreams?: Readonly<Record<string, true>>;
}
function isRealUserMessage(e: SessionEvent): boolean {
  return (
    (e.type === 'user_message' || e.type === 'intervention_sent') &&
    !e.id.startsWith(OPTIMISTIC_USER_ID_PREFIX)
  );
}

function extractText(e: SessionEvent): string | undefined {
  const d = e.data as any;
  return typeof d?.text === 'string' ? d.text : undefined;
}

/**
 * 사용자가 보낸 메시지를 즉시 채팅 뷰에 표시하기 위한 optimistic SessionEvent를 만든다.
 * 이 이벤트는 events 배열이 아니라 chatStore.pendingOptimisticBySession 슬롯에 보관되며,
 * 전송 당시 마지막 서버 이벤트 뒤에 가상 항목으로 표시된다.
 * 서버에서 진짜 user_message/intervention_sent SSE가 도착하면 mergeEvents가 슬롯을
 * 비운다 (시나리오 A). events 배열에 들어가지 않으므로 RN ScrollView의
 * maintainVisibleContentPosition Caveat 1(reordering jank)을 회피한다.
 *
 * id 충돌 회피는 Date.now() + Math.random() 7자리로 충분 (세션 내 동시성 낮음).
 */
export function createOptimisticUserEvent(
  text: string,
  variant: 'user_message' | 'intervention_sent',
): SessionEvent {
  const rand = Math.random().toString(36).slice(2, 9);
  return {
    id: `${OPTIMISTIC_USER_ID_PREFIX}${Date.now()}-${rand}`,
    type: variant,
    data: { text, user: 'soul-app' },
  };
}

export function getOptimisticAfterEventId(event: SessionEvent): string | null {
  const id = (event.data as any)?.[OPTIMISTIC_AFTER_EVENT_ID_KEY];
  return typeof id === 'string' ? id : null;
}

/**
 * handleSend 시점에 옵티미스틱 SessionEvent의 type을 결정하는 시그널 함수.
 *
 * 서버 task_manager.add_intervention(soul-server)의 분기를 거울처럼 따른다:
 * - RUNNING 세션: intervention_queue에 push → callback이 'intervention_sent'(주황) emit
 * - 그 외(완료/오류/중단/idle): create_task로 auto-resume → _persist_initial_messages가
 *   'user_message'(파랑) emit
 *
 * 이 함수는 옵티미스틱 표시 색을 진짜 이벤트와 정합시키는 용도이며,
 * race(클릭 직후 status 전환 등)에서 잘못 추측해도 mergeEvents의 type-agnostic dedup이
 * 받쳐주므로 두 말풍선이 동시에 보이지 않는다 (정본은 dedup, 본 함수는 표시 정합).
 *
 * §10(인터페이스가 테스트 표면): ChatBody 풀 mount 비용 회피 + 분기 의미 명시화.
 */
export function pickOptimisticVariant(
  status: string | undefined,
): 'user_message' | 'intervention_sent' {
  return status === 'running' ? 'intervention_sent' : 'user_message';
}

interface ChatStore {
  persistentDisplaySettings: PersistentDisplaySettingsState | null;
  persistentDisplaySettingsRequestId: number;
  beginPersistentDisplaySettingsLoad: (sessionId: string) => number;
  finishPersistentDisplaySettingsLoad: (
    sessionId: string,
    requestId: number,
    settings: PersistentChatDisplaySettings | null,
  ) => void;
  applyPersistentDisplaySettings: (
    sessionId: string,
    settings: PersistentChatDisplaySettings,
  ) => void;
  clearPersistentDisplaySettings: (sessionId?: string) => void;
  eventsBySession: Record<string, SessionEvent[]>;
  lastEventIdBySession: Record<string, string>;
  /**
   * 새 세션 생성 직후 ChatBody가 mount되기 전까지 사용자의 첫 prompt를 보관.
   * ChatBody mount effect에서 소비하여 optimistic insert.
   * 정본 위치: chatStore (NewSessionSheet → ChatBody 통신 채널, §3).
   *
   * clearSession은 의도적으로 이 영역을 비우지 않는다. 누수 방지:
   * consumePendingFirstMessage가 set한 sessionId 외에는 영향 없으며, 같은 sessionId가
   * 두 번 set되는 경우는 없다 (createSession이 매번 새 sid를 발급).
   */
  pendingFirstMessageBySession: Record<string, string>;
  /**
   * optimistic SessionEvent를 events 배열에서 분리하여 보관 (RN ScrollView Caveat 1 회피).
   * events 배열은 서버 정본만 담는다 (design-principles §3).
   *
   * 슬롯 항목은 전송 시점의 마지막 서버 이벤트 뒤에 표시되며, 진짜
   * user_message/intervention_sent가 도착하면 mergeEvents가 슬롯을 비운다.
   */
  pendingOptimisticBySession: Record<string, PendingOptimisticEvent>;
  /**
   * 라이브 text_delta / thinking_delta 전용 임시 슬롯.
   *
   * 스트리밍 중 누적 텍스트는 events 배열에 매번 append하지 않는다. 세션별 슬롯에
   * 최신 누적 payload만 교체하여 RN list data churn을 제한하고, stream boundary에서만
   * 필요한 경우 최신 1건을 history에 finalize한다.
   */
  streamingSlotsBySession: Record<string, StreamingSlots>;
  claudeRuntimeBySession: Record<string, ClaudeRuntimeView>;
  /**
   * 이벤트를 정렬 키 기반으로 머지한다 (단일 정본, design-principles §5).
   *
   * 정렬 키: Number(event.id). DB events.id가 숫자 단조증가라 안전하다.
   * eid 누락 fallback id (`${type}-${Date.now()}`)는 NaN으로 매핑되어
   * 항상 끝(가장 최신)으로 정렬된다.
   *
   * dedup은 string id로 수행하므로 fallback id 포함 안전.
   *
   * 슬롯 비움(시나리오 A): incoming에 user-class real(user_message OR intervention_sent)이
   * 있고 슬롯의 텍스트와 일치하면 슬롯을 비운다 (type-agnostic — 같은 텍스트는 같은
   * 사용자 발화로 간주). 서버는 RUNNING 세션엔 intervention_sent를, 그 외엔 auto-resume
   * 후 user_message를 emit하므로 옵티미스틱 type과 진짜 이벤트 type이 다를 수 있다.
   *
   * 호출 경로:
   * - history REST 페이지(과거 이벤트, ASC 가정).
   * - 라이브 SSE 단건(가장 최신 → mergeSorted 끝에 정착).
   */
  mergeEvents: (sessionId: string, events: SessionEvent[]) => void;
  /** streaming slot 최신값 교체 — events 배열에는 append하지 않는다. */
  setStreamingEvent: (
    sessionId: string,
    kind: StreamingSlotKind,
    event: SessionEvent,
  ) => void;
  /** text_snapshot commit: replace all identified assistant streams atomically. */
  replaceAssistantStreamingEvents: (
    sessionId: string,
    events: readonly SessionEvent[],
    snapshotStreamIdentities?: readonly string[],
  ) => void;
  /** streaming slot 최신값 1건을 events history에 넣고 slot을 비운다. */
  finalizeStreamingEvent: (
    sessionId: string,
    kind: StreamingSlotKind,
    streamIdentity?: string,
  ) => void;
  /** streaming slot을 history append 없이 비운다. final assistant_message가 대체할 때 사용. */
  clearStreamingEvent: (
    sessionId: string,
    kind: StreamingSlotKind,
    streamIdentity?: string,
  ) => void;
  /** 세션의 모든 streaming slot을 비운다. session switch/unmount cleanup용. */
  clearStreamingEvents: (sessionId: string) => void;
  applyClaudeRuntimeEvent: (sessionId: string, type: string, data: unknown) => void;
  setClaudeRuntimeTasks: (sessionId: string, response: ClaudeRuntimeTasksResponse) => void;
  setClaudeRuntimeSchedules: (
    sessionId: string,
    response: ClaudeRuntimeSchedulesResponse,
  ) => void;
  /**
   * optimistic SessionEvent를 슬롯에 set한다.
   *
   * 시나리오 B 가드: events에 같은 텍스트의 user-class real(user_message OR
   * intervention_sent)이 이미 있으면 슬롯에 넣지 않는다 (type-agnostic — SSE가 mount
   * 전에 먼저 도착한 초기 프롬프트를 처리). 명시적인 새 전송은 allowSameText로 기존 기록과
   * 같은 문장이어도 새 pending cell을 둔다.
   */
  setPendingOptimistic: (
    sessionId: string,
    event: PendingOptimisticEvent,
    allowSameText?: boolean,
  ) => void;
  /**
   * 사용자가 실패 문장을 입력창으로 옮기는 등 명시 폐기 때 슬롯을 비운다.
   * 서버 이벤트가 도착하는 경로에서는 mergeEvents가 자동 비운다.
   */
  clearPendingOptimistic: (sessionId: string, expectedId?: string) => void;
  updatePendingOptimisticStatus: (
    sessionId: string,
    expectedId: string,
    status: PendingOptimisticStatus,
    failureReason?: string,
  ) => void;
  setLastEventId: (sessionId: string, id: string) => void;
  setPendingFirstMessage: (sessionId: string, text: string) => void;
  consumePendingFirstMessage: (sessionId: string) => string | undefined;
  clearSession: (sessionId: string) => void;
}

function sortKey(e: SessionEvent): number {
  const n = Number(e.id);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function latestNumericEventId(events: SessionEvent[]): string | null {
  let latest: SessionEvent | undefined;
  for (const event of events) {
    if (!Number.isFinite(Number(event.id))) continue;
    if (!latest || Number(event.id) > Number(latest.id)) {
      latest = event;
    }
  }
  return latest?.id ?? null;
}

function shouldAdvanceLastEventId(
  current: string | undefined,
  next: string,
): boolean {
  if (current === undefined) return true;
  if (current === next) return false;
  const currentNumber = Number(current);
  const nextNumber = Number(next);
  if (Number.isFinite(currentNumber) && Number.isFinite(nextNumber)) {
    return nextNumber > currentNumber;
  }
  return true;
}

function hasAssistantMessage(events: SessionEvent[]): boolean {
  return events.some((event) => event.type === 'assistant_message');
}

function streamingIdentity(event: SessionEvent): string | null {
  const value = event.data?.streamIdentity;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function shallowEqualRecord(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function sameStreamingEvent(
  left: SessionEvent | undefined,
  right: SessionEvent | undefined,
): boolean {
  return left === right || Boolean(
    left
    && right
    && left.id === right.id
    && left.type === right.type
    && shallowEqualRecord(left.data, right.data),
  );
}

function sameAssistantStreams(
  left: Readonly<Record<string, SessionEvent>> | undefined,
  right: Readonly<Record<string, SessionEvent>>,
): boolean {
  const leftKeys = Object.keys(left ?? {});
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && rightKeys.every((identity) => (
      sameStreamingEvent(left?.[identity], right[identity])
    ));
}

function sameSnapshotStreams(
  left: Readonly<Record<string, true>> | undefined,
  right: Readonly<Record<string, true>>,
): boolean {
  const leftKeys = Object.keys(left ?? {});
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && rightKeys.every((identity) => left?.[identity] === true);
}

function mergeSorted(
  existing: SessionEvent[],
  fresh: SessionEvent[]
): SessionEvent[] {
  if (fresh.length === 0) return existing;
  const seenIds = new Set(existing.map((e) => e.id));
  const dedup = fresh.filter((event) => {
    if (seenIds.has(event.id)) return false;
    seenIds.add(event.id);
    return true;
  });
  if (dedup.length === 0) return existing;
  // existing은 mergeEvents가 유일한 갱신 경로이므로 ASC invariant 유지.
  // fresh는 호출자가 정렬을 보장하지 못할 수 있어 명시적으로 정렬한 뒤 머지.
  const dedupSorted = [...dedup].sort((a, b) => sortKey(a) - sortKey(b));
  const out: SessionEvent[] = [];
  let i = 0;
  let j = 0;
  while (i < existing.length && j < dedupSorted.length) {
    if (sortKey(existing[i]) <= sortKey(dedupSorted[j])) {
      out.push(existing[i++]);
    } else {
      out.push(dedupSorted[j++]);
    }
  }
  while (i < existing.length) out.push(existing[i++]);
  while (j < dedupSorted.length) out.push(dedupSorted[j++]);
  return out;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  persistentDisplaySettings: null,
  persistentDisplaySettingsRequestId: 0,
  beginPersistentDisplaySettingsLoad: (sessionId) => {
    let requestId = 0;
    set((state) => {
      requestId = state.persistentDisplaySettingsRequestId + 1;
      return {
        persistentDisplaySettingsRequestId: requestId,
        persistentDisplaySettings: { sessionId, settings: null, requestId },
      };
    });
    return requestId;
  },
  finishPersistentDisplaySettingsLoad: (sessionId, requestId, settings) =>
    set((state) => {
      if (state.persistentDisplaySettings?.sessionId !== sessionId
        || state.persistentDisplaySettings.requestId !== requestId) return state;
      return {
        persistentDisplaySettings: { sessionId, settings, requestId },
      };
    }),
  applyPersistentDisplaySettings: (sessionId, settings) =>
    set((state) => {
      if (state.persistentDisplaySettings?.sessionId !== sessionId) return state;
      const requestId = state.persistentDisplaySettingsRequestId + 1;
      return {
        persistentDisplaySettingsRequestId: requestId,
        persistentDisplaySettings: { sessionId, settings, requestId },
      };
    }),
  clearPersistentDisplaySettings: (sessionId) =>
    set((state) => {
      if (sessionId && state.persistentDisplaySettings?.sessionId !== sessionId) return state;
      return {
        persistentDisplaySettings: null,
        persistentDisplaySettingsRequestId: state.persistentDisplaySettingsRequestId + 1,
      };
    }),
  eventsBySession: {},
  lastEventIdBySession: {},
  pendingFirstMessageBySession: {},
  pendingOptimisticBySession: {},
  streamingSlotsBySession: {},
  claudeRuntimeBySession: {},
  mergeEvents: (sessionId, events) =>
    set((state) => {
      const existing = state.eventsBySession[sessionId] ?? [];
      const slot = state.pendingOptimisticBySession[sessionId];

      // 시나리오 A — 진짜가 늦게 도착: incoming에 user-class real(user_message OR
      // intervention_sent)이 있고 슬롯 항목과 텍스트가 일치하면 슬롯 비움 (type-agnostic).
      // type을 비교하지 않는 이유: 옵티미스틱은 "사용자가 이 텍스트를 보냈다"의 placeholder.
      // 서버가 RUNNING 여부에 따라 intervention_sent / user_message 중 어느 쪽을 emit하든
      // 동일한 사용자 발화이므로 text 일치만으로 dedup하는 것이 정본을 하나로 유지하는
      // 형태(§3) + race·잘못된 추측에도 안전.
      let nextSlot: PendingOptimisticEvent | undefined = slot;
      if (slot) {
        const slotText = extractText(slot);
        for (const e of events) {
          if (
            isRealUserMessage(e) &&
            extractText(e) === slotText
          ) {
            nextSlot = undefined;
            break;
          }
        }
      }

      const merged = mergeSorted(existing, events);
      const eventsChanged = merged !== existing;
      const slotChanged = nextSlot !== slot;
      const streamingSlots = state.streamingSlotsBySession[sessionId];
      let nextStreamingSlots = streamingSlots;
      if (streamingSlots && hasAssistantMessage(events)) {
        const nextSlots = { ...streamingSlots };
        let changed = false;
        if (nextSlots.assistant) {
          delete nextSlots.assistant;
          changed = true;
        }
        if (nextSlots.assistantByStream || nextSlots.assistantSnapshotStreams) {
          const finalIdentities = new Set(
            events
              .filter((event) => (
                event.type === 'assistant_message'
                && event.data?._final_for_live_stream === true
              ))
              .map(streamingIdentity)
              .filter((identity): identity is string => identity !== null),
          );
          if (finalIdentities.size > 0) {
            if (nextSlots.assistantByStream) {
              const nextByStream = { ...nextSlots.assistantByStream };
              for (const identity of finalIdentities) {
                if (!(identity in nextByStream)) continue;
                delete nextByStream[identity];
                changed = true;
              }
              if (Object.keys(nextByStream).length === 0) {
                delete nextSlots.assistantByStream;
              } else {
                nextSlots.assistantByStream = nextByStream;
              }
            }
            if (nextSlots.assistantSnapshotStreams) {
              const nextSnapshotStreams = {
                ...nextSlots.assistantSnapshotStreams,
              };
              for (const identity of finalIdentities) {
                if (!(identity in nextSnapshotStreams)) continue;
                delete nextSnapshotStreams[identity];
                changed = true;
              }
              if (Object.keys(nextSnapshotStreams).length === 0) {
                delete nextSlots.assistantSnapshotStreams;
              } else {
                nextSlots.assistantSnapshotStreams = nextSnapshotStreams;
              }
            }
          }
        }
        if (changed) nextStreamingSlots = nextSlots;
      }
      const streamingSlotsChanged = nextStreamingSlots !== streamingSlots;

      if (!eventsChanged && !slotChanged && !streamingSlotsChanged) {
        return state;
      }

      const patch: Partial<ChatStore> = {};
      if (eventsChanged) {
        patch.eventsBySession = { ...state.eventsBySession, [sessionId]: merged };
      }
      if (slotChanged) {
        const nextMap = { ...state.pendingOptimisticBySession };
        if (nextSlot === undefined) delete nextMap[sessionId];
        else nextMap[sessionId] = nextSlot;
        patch.pendingOptimisticBySession = nextMap;
      }
      if (streamingSlotsChanged && nextStreamingSlots) {
        const nextStreamingSlotsBySession = { ...state.streamingSlotsBySession };
        if (Object.keys(nextStreamingSlots).length === 0) {
          delete nextStreamingSlotsBySession[sessionId];
        } else {
          nextStreamingSlotsBySession[sessionId] = nextStreamingSlots;
        }
        patch.streamingSlotsBySession = nextStreamingSlotsBySession;
      }
      return patch;
    }),
  setStreamingEvent: (sessionId, kind, event) =>
    set((state) => {
      const slots = state.streamingSlotsBySession[sessionId] ?? {};
      const identity = kind === 'assistant' ? streamingIdentity(event) : null;
      if (identity) {
        const assistantByStream = slots.assistantByStream ?? {};
        return {
          streamingSlotsBySession: {
            ...state.streamingSlotsBySession,
            [sessionId]: {
              ...slots,
              assistantByStream: {
                ...assistantByStream,
                [identity]: mergeAppendOnlyStreamingDelta(
                  assistantByStream[identity],
                  event,
                ),
              },
            },
          },
        };
      }
      return {
        streamingSlotsBySession: {
          ...state.streamingSlotsBySession,
          [sessionId]: {
            ...slots,
            [kind]: mergeAppendOnlyStreamingDelta(slots[kind], event),
          },
        },
      };
    }),
  replaceAssistantStreamingEvents: (sessionId, events, snapshotIdentities) =>
    set((state) => {
      const slots = state.streamingSlotsBySession[sessionId] ?? {};
      const assistantByStream: Record<string, SessionEvent> = {};
      for (const event of events) {
        const identity = streamingIdentity(event);
        if (!identity) continue;
        assistantByStream[identity] = event;
      }
      const assistantSnapshotStreams: Record<string, true> = {};
      for (const identity of snapshotIdentities ?? Object.keys(assistantByStream)) {
        if (identity) assistantSnapshotStreams[identity] = true;
      }
      if (
        !slots.assistant
        && sameAssistantStreams(slots.assistantByStream, assistantByStream)
        && sameSnapshotStreams(
          slots.assistantSnapshotStreams,
          assistantSnapshotStreams,
        )
      ) {
        return state;
      }
      const nextSlots = { ...slots };
      delete nextSlots.assistant;
      delete nextSlots.assistantByStream;
      delete nextSlots.assistantSnapshotStreams;
      if (Object.keys(assistantByStream).length > 0) {
        nextSlots.assistantByStream = assistantByStream;
      }
      if (Object.keys(assistantSnapshotStreams).length > 0) {
        nextSlots.assistantSnapshotStreams = assistantSnapshotStreams;
      }
      const nextStreamingSlotsBySession = { ...state.streamingSlotsBySession };
      if (Object.keys(nextSlots).length === 0) {
        delete nextStreamingSlotsBySession[sessionId];
      } else {
        nextStreamingSlotsBySession[sessionId] = nextSlots;
      }
      return { streamingSlotsBySession: nextStreamingSlotsBySession };
    }),
  finalizeStreamingEvent: (sessionId, kind, streamIdentity) =>
    set((state) => {
      const slots = state.streamingSlotsBySession[sessionId];
      if (!slots) return state;
      // A recovered snapshot owns its row until the matching durable final.
      // text_end alone must not expose the raw replay fragments underneath it.
      if (
        kind === 'assistant'
        && streamIdentity
        && slots.assistantSnapshotStreams?.[streamIdentity]
      ) {
        return state;
      }
      const events: SessionEvent[] = [];
      const nextSlots = { ...slots };
      if (kind === 'assistant' && slots.assistantByStream) {
        const nextByStream = { ...slots.assistantByStream };
        if (streamIdentity) {
          const event = nextByStream[streamIdentity];
          if (event) events.push(event);
          delete nextByStream[streamIdentity];
        } else {
          events.push(...Object.values(nextByStream));
          for (const identity of Object.keys(nextByStream)) delete nextByStream[identity];
        }
        if (Object.keys(nextByStream).length === 0) {
          delete nextSlots.assistantByStream;
        } else {
          nextSlots.assistantByStream = nextByStream;
        }
      }
      const legacyEvent = slots[kind];
      if (!streamIdentity && legacyEvent) {
        events.push(legacyEvent);
        delete nextSlots[kind];
      }
      if (events.length === 0) return state;

      const existing = state.eventsBySession[sessionId] ?? [];
      const merged = mergeSorted(existing, events);
      const nextStreamingSlotsBySession = { ...state.streamingSlotsBySession };
      if (Object.keys(nextSlots).length === 0) {
        delete nextStreamingSlotsBySession[sessionId];
      } else {
        nextStreamingSlotsBySession[sessionId] = nextSlots;
      }

      return {
        eventsBySession:
          merged === existing
            ? state.eventsBySession
            : { ...state.eventsBySession, [sessionId]: merged },
        streamingSlotsBySession: nextStreamingSlotsBySession,
      };
    }),
  clearStreamingEvent: (sessionId, kind, streamIdentity) =>
    set((state) => {
      const slots = state.streamingSlotsBySession[sessionId];
      if (!slots) return state;
      const nextSlots = { ...slots };
      let changed = false;
      if (kind === 'assistant' && slots.assistantByStream) {
        if (streamIdentity && slots.assistantByStream[streamIdentity]) {
          const nextByStream = { ...slots.assistantByStream };
          delete nextByStream[streamIdentity];
          if (Object.keys(nextByStream).length === 0) {
            delete nextSlots.assistantByStream;
          } else {
            nextSlots.assistantByStream = nextByStream;
          }
          changed = true;
        } else if (!streamIdentity) {
          delete nextSlots.assistantByStream;
          changed = true;
        }
      }
      if (kind === 'assistant' && slots.assistantSnapshotStreams) {
        if (
          streamIdentity
          && slots.assistantSnapshotStreams[streamIdentity]
        ) {
          const nextSnapshotStreams = { ...slots.assistantSnapshotStreams };
          delete nextSnapshotStreams[streamIdentity];
          if (Object.keys(nextSnapshotStreams).length === 0) {
            delete nextSlots.assistantSnapshotStreams;
          } else {
            nextSlots.assistantSnapshotStreams = nextSnapshotStreams;
          }
          changed = true;
        } else if (!streamIdentity) {
          delete nextSlots.assistantSnapshotStreams;
          changed = true;
        }
      }
      if (!streamIdentity && slots[kind]) {
        delete nextSlots[kind];
        changed = true;
      }
      if (!changed) return state;
      const nextStreamingSlotsBySession = { ...state.streamingSlotsBySession };
      if (Object.keys(nextSlots).length === 0) {
        delete nextStreamingSlotsBySession[sessionId];
      } else {
        nextStreamingSlotsBySession[sessionId] = nextSlots;
      }
      return { streamingSlotsBySession: nextStreamingSlotsBySession };
    }),
  clearStreamingEvents: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.streamingSlotsBySession)) return state;
      const { [sessionId]: _omit, ...rest } = state.streamingSlotsBySession;
      return { streamingSlotsBySession: rest };
    }),
  applyClaudeRuntimeEvent: (sessionId, type, data) =>
    set((state) => {
      const nextRuntime = applyClaudeRuntimePayload(
        state.claudeRuntimeBySession[sessionId],
        type,
        data,
      );
      if (!nextRuntime || nextRuntime === state.claudeRuntimeBySession[sessionId]) {
        return state;
      }
      noteClaudeRuntimeListEvent(sessionId, type, data);
      return {
        claudeRuntimeBySession: {
          ...state.claudeRuntimeBySession,
          [sessionId]: nextRuntime,
        },
      };
    }),
  setClaudeRuntimeTasks: (sessionId, response) =>
    set((state) => {
      const current = state.claudeRuntimeBySession[sessionId];
      return {
        claudeRuntimeBySession: {
          ...state.claudeRuntimeBySession,
          [sessionId]: {
            ...(current ?? {}),
            sessionState: response.sessionState ?? undefined,
            runtimeSessionId: response.runtimeSessionId ?? undefined,
            updatedAt: response.updatedAt ?? Date.now(),
            tasks: Object.fromEntries(response.tasks.map((task) => [task.taskId, task])),
            schedules: current?.schedules ?? {},
            notifications: response.notifications
              ? Object.fromEntries(
                  response.notifications.map((notification) => [
                    notification.notificationId,
                    notification,
                  ]),
                )
              : current?.notifications ?? {},
            remoteTriggers: response.remoteTriggers
              ? Object.fromEntries(
                  response.remoteTriggers.map((trigger) => [trigger.triggerId, trigger]),
                )
              : current?.remoteTriggers ?? {},
            transcriptMirror:
              response.transcriptMirror !== undefined
                ? response.transcriptMirror
                : current?.transcriptMirror ?? null,
            planMode: response.planMode ?? current?.planMode ?? null,
            worktreeMode: response.worktreeMode ?? current?.worktreeMode ?? null,
            nextScheduleRunAt: current?.nextScheduleRunAt ?? null,
          },
        },
      };
    }),
  setClaudeRuntimeSchedules: (sessionId, response) =>
    set((state) => ({
      claudeRuntimeBySession: {
        ...state.claudeRuntimeBySession,
        [sessionId]: {
          ...(state.claudeRuntimeBySession[sessionId] ?? {
            tasks: {},
            notifications: {},
            remoteTriggers: {},
            updatedAt: Date.now(),
          }),
          updatedAt: Date.now(),
          schedules: Object.fromEntries(
            response.schedules.map((schedule) => [schedule.scheduleId, schedule]),
          ),
          nextScheduleRunAt: response.nextRunAt,
        },
      },
    })),
  setPendingOptimistic: (sessionId, event, allowSameText = false) =>
    set((state) => {
      // 시나리오 B 가드: events에 같은 텍스트의 user-class real이 이미 있으면 슬롯에
      // 넣지 않는다 (type-agnostic — slot type과 무관하게 사용자 발화 동치로 본다).
      const text = extractText(event);
      const existing = state.eventsBySession[sessionId] ?? [];
      if (text !== undefined && !allowSameText) {
        for (const e of existing) {
          if (
            isRealUserMessage(e) &&
            extractText(e) === text
          ) {
            return state;
          }
        }
      }
      const anchorId = latestNumericEventId(existing);
      const anchoredEvent: PendingOptimisticEvent = {
        ...event,
        data: {
          ...event.data,
          [OPTIMISTIC_AFTER_EVENT_ID_KEY]: anchorId,
        },
      };
      return {
        pendingOptimisticBySession: {
          ...state.pendingOptimisticBySession,
          [sessionId]: anchoredEvent,
        },
      };
    }),
  clearPendingOptimistic: (sessionId, expectedId) =>
    set((state) => {
      const current = state.pendingOptimisticBySession[sessionId];
      if (!current || (expectedId !== undefined && current.id !== expectedId)) return state;
      const { [sessionId]: _omit, ...rest } = state.pendingOptimisticBySession;
      return { pendingOptimisticBySession: rest };
    }),
  updatePendingOptimisticStatus: (sessionId, expectedId, status, failureReason) =>
    set((state) => {
      const current = state.pendingOptimisticBySession[sessionId];
      if (!current || current.id !== expectedId) return state;
      const next: PendingOptimisticEvent = { ...current, pendingStatus: status };
      if (status === 'failed') next.failureReason = failureReason;
      else delete next.failureReason;
      return {
        pendingOptimisticBySession: {
          ...state.pendingOptimisticBySession,
          [sessionId]: next,
        },
      };
    }),
  setLastEventId: (sessionId, id) =>
    set((state) => {
      if (!shouldAdvanceLastEventId(state.lastEventIdBySession[sessionId], id)) {
        return state;
      }
      return {
        lastEventIdBySession: {
          ...state.lastEventIdBySession,
          [sessionId]: id,
        },
      };
    }),
  setPendingFirstMessage: (sessionId, text) =>
    set((state) => ({
      pendingFirstMessageBySession: {
        ...state.pendingFirstMessageBySession,
        [sessionId]: text,
      },
    })),
  consumePendingFirstMessage: (sessionId) => {
    // get()으로 store 자기 자신 참조 (zustand 표준 패턴)
    const text = get().pendingFirstMessageBySession[sessionId];
    if (text === undefined) return undefined;
    set((state) => {
      const { [sessionId]: _omit, ...rest } = state.pendingFirstMessageBySession;
      return { pendingFirstMessageBySession: rest };
    });
    return text;
  },
  clearSession: (sessionId) => {
    invalidateClaudeRuntimeLists(sessionId);
    set((state) => {
      // eventsBySession, lastEventIdBySession, pendingOptimisticBySession 모두 제거.
      // pendingFirstMessageBySession은 의도적으로 비우지 않는다 (인터페이스 docstring 참조).
      const { [sessionId]: _e, ...restEvents } = state.eventsBySession;
      const { [sessionId]: _l, ...restIds } = state.lastEventIdBySession;
      const { [sessionId]: _o, ...restOpt } = state.pendingOptimisticBySession;
      const { [sessionId]: _s, ...restStreamingSlots } = state.streamingSlotsBySession;
      const { [sessionId]: _r, ...restRuntime } = state.claudeRuntimeBySession;
      return {
        eventsBySession: restEvents,
        lastEventIdBySession: restIds,
        pendingOptimisticBySession: restOpt,
        streamingSlotsBySession: restStreamingSlots,
        claudeRuntimeBySession: restRuntime,
      };
    });
  },
}));

subscribeAuthScope(() => {
  useChatStore.setState({
    persistentDisplaySettings: null,
    persistentDisplaySettingsRequestId: useChatStore.getState().persistentDisplaySettingsRequestId + 1,
    eventsBySession: {},
    lastEventIdBySession: {},
    pendingFirstMessageBySession: {},
    pendingOptimisticBySession: {},
    streamingSlotsBySession: {},
    claudeRuntimeBySession: {},
  });
});

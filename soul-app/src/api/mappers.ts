/**
 * Wire → Session 정규화 정본.
 *
 * orch wire는 3변형(REST `/api/sessions` 정본 camelCase + SSE `session_created.session`
 * MIXED + SSE `session_updated` MIXED)이므로, soul-app 안에서는 한 mapper가 모든 입력을
 * 받아 camelCase `Session`(api/types.ts) 단일 정본으로 변환한다 — design-principles
 * §3 정본 하나.
 *
 * 비교: `packages/soul-ui/src/shared/mappers.ts:toSessionSummary` (web 정본).
 * soul-app은 llm 세션 채팅 UI 미지원이라 llmProvider 등 web 전용 필드를 두지 않는다.
 *
 * 본 mapper는 snake/camel 양쪽 키를 받는다 — REST는 camel 단일이지만 SSE의 to_session_info
 * 결과는 mixed라 한 함수로 통합한다. snake 기존 표시 정본은 점진적으로 사라질 예정.
 */

import type {
  ReviewState,
  Session,
  SessionEndedReconciliation,
} from './types';
import { normalizeFeedLastMessage } from '../lib/session-feed-activity';
import { normalizePendingAttentionSnapshot } from '../lib/session-attention';

/** raw에서 camel을 우선 시도하고 snake로 fallback. 둘 다 없으면 undefined. */
function pick<T>(raw: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) {
    if (raw[k] !== undefined) return raw[k] as T;
  }
  return undefined;
}

function normalizeReviewState(value: unknown): ReviewState {
  return value === 'needs_review' || value === 'acknowledged'
    ? value
    : 'not_required';
}

function normalizeEventId(value: unknown): number | undefined {
  const eventId = typeof value === 'number' || typeof value === 'string'
    ? Number(value)
    : NaN;
  return Number.isSafeInteger(eventId) && eventId >= 0 ? eventId : undefined;
}

function nullableEventIdField(
  raw: Record<string, unknown>,
  ...keys: string[]
): number | null | undefined {
  for (const key of keys) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    if (value === null) return null;
    return normalizeEventId(value);
  }
  return undefined;
}

function nullableStringField(
  raw: Record<string, unknown>,
  ...keys: string[]
): string | null | undefined {
  const value = pick<unknown>(raw, ...keys);
  return typeof value === 'string' || value === null ? value : undefined;
}

/**
 * 서버 응답(REST 또는 SSE)을 클라이언트 Session(camelCase)으로 변환.
 *
 * 입력 모양:
 * - REST /api/sessions sessionList[i] — camelCase 21 키 (Phase A-bis 정본)
 * - SSE session_created.session — to_session_info 결과 (MIXED)
 *
 * 정규화 규칙:
 * - 식별자: agentSessionId ← agentSessionId | agent_session_id
 * - timestamp: createdAt/updatedAt ← *_at | *At
 * - profile/user 필드: 이미 camel — 그대로
 * - 모델 메타: modelLabel/model_label 양쪽을 받아 서버 표시 라벨을 보존
 *
 * agentSessionId가 비면 빈 문자열 반환 — 호출자(store upsert)가 falsy 체크로 skip.
 */
export function toSession(raw: Record<string, unknown> | null | undefined): Session {
  if (!raw) {
    return {
      agentSessionId: '',
      displayName: null,
      status: 'unknown',
      createdAt: '',
      updatedAt: '',
    };
  }
  const lastMsg = pick<unknown>(raw, 'lastMessage', 'last_message');
  const agentSessionId = pick<string>(raw, 'agentSessionId', 'agent_session_id') ?? '';
  const attentionSnapshot = normalizePendingAttentionSnapshot(
    pick<unknown>(raw, 'pendingAttentions', 'pending_attentions'),
    pick<unknown>(raw, 'attentionRevision', 'attention_revision'),
    agentSessionId,
  );
  const feedLastEventId = nullableEventIdField(
    raw,
    'feedLastEventId',
    'feed_last_event_id',
  );
  return {
    agentSessionId,
    cardId: raw.cardId as string | null | undefined,
    displayName: (pick<string | null>(raw, 'displayName', 'display_name') ?? null),
    status: pick<string>(raw, 'status') ?? 'unknown',
    lastEventId: normalizeEventId(pick(raw, 'lastEventId', 'last_event_id')),
    ...(feedLastEventId === undefined ? {} : { feedLastEventId }),
    terminationReason: nullableStringField(
      raw,
      'terminationReason',
      'termination_reason',
    ),
    terminationDetail: nullableStringField(
      raw,
      'terminationDetail',
      'termination_detail',
    ),
    reviewRequired:
      pick<unknown>(raw, 'reviewRequired', 'review_required') === true,
    reviewState: normalizeReviewState(
      pick<unknown>(raw, 'reviewState', 'review_state'),
    ),
    createdAt: pick<string>(raw, 'createdAt', 'created_at') ?? '',
    updatedAt: pick<string>(raw, 'updatedAt', 'updated_at') ?? '',
    eventCount: pick<number>(raw, 'eventCount', 'event_count'),
    folderId: pick<string | null>(raw, 'folderId', 'folder_id') ?? null,
    nodeId: pick<string>(raw, 'nodeId', 'node_id'),
    lastMessage: normalizeFeedLastMessage(lastMsg),
    ...(attentionSnapshot ?? {}),
    sessionType: pick<string>(raw, 'sessionType', 'session_type'),
    prompt: pick<string | null>(raw, 'prompt') ?? null,
    agentId: pick<string | null>(raw, 'agentId', 'agent_id') ?? null,
    agentName: pick<string | null>(raw, 'agentName', 'agent_name') ?? null,
    agentPortraitUrl:
      pick<string | null>(raw, 'agentPortraitUrl', 'agent_portrait_url') ?? null,
    backend: pick<string | null>(raw, 'backend') ?? null,
    modelPreset:
      pick<string | null>(raw, 'modelPreset', 'model_preset') ?? null,
    reasoningEffort:
      pick<string | null>(raw, 'reasoningEffort', 'reasoning_effort') ?? null,
    modelLabel:
      pick<string | null>(raw, 'modelLabel', 'model_label') ?? null,
    userName: pick<string | null>(raw, 'userName', 'user_name') ?? null,
    userPortraitUrl:
      pick<string | null>(raw, 'userPortraitUrl', 'user_portrait_url') ?? null,
    callerSessionId:
      pick<string | null>(raw, 'callerSessionId', 'caller_session_id') ?? null,
  };
}

/**
 * SSE `session_updated` payload를 store에 머지할 Partial<Session>으로 변환.
 *
 * wire 모양(MIXED, atom b558ca3b):
 *   { agent_session_id, status, updated_at, last_event_id?, last_read_event_id?,
 *     last_message?, userName?, userPortraitUrl?, ... }
 *
 * null/undefined는 skip한다 — partial update의 의미를 보존 (기존 값 덮어쓰지 않음).
 * web 정본 `buildSessionUpdates`와 동일 정책.
 *
 * agent_session_id/agentSessionId는 식별자라 reply에 포함되지 않는다 — 호출자가 별도로
 * extract하여 store.updateSession(sid, patch) 형태로 호출.
 */
export function applySessionUpdated(
  raw: Record<string, unknown>,
): Partial<Session> {
  const updates: Partial<Session> = {};
  if (raw.cardId !== undefined) updates.cardId = raw.cardId as string | null;
  const status = pick<string>(raw, 'status');
  if (status != null) updates.status = status;

  const lastEventId = normalizeEventId(
    pick(raw, 'lastEventId', 'last_event_id'),
  );
  if (lastEventId !== undefined) updates.lastEventId = lastEventId;

  const feedLastEventId = nullableEventIdField(
    raw,
    'feedLastEventId',
    'feed_last_event_id',
  );
  if (feedLastEventId !== undefined) updates.feedLastEventId = feedLastEventId;

  const terminationReason = nullableStringField(
    raw,
    'terminationReason',
    'termination_reason',
  );
  if (terminationReason !== undefined) {
    updates.terminationReason = terminationReason;
  }

  const terminationDetail = nullableStringField(
    raw,
    'terminationDetail',
    'termination_detail',
  );
  if (terminationDetail !== undefined) {
    updates.terminationDetail = terminationDetail;
  }

  const reviewRequired = pick<unknown>(
    raw,
    'reviewRequired',
    'review_required',
  );
  if (typeof reviewRequired === 'boolean') {
    updates.reviewRequired = reviewRequired;
  }

  const reviewState = pick<unknown>(raw, 'reviewState', 'review_state');
  if (
    reviewState === 'not_required' ||
    reviewState === 'needs_review' ||
    reviewState === 'acknowledged'
  ) {
    updates.reviewState = reviewState;
  }

  const lastMessage = normalizeFeedLastMessage(
    pick<unknown>(raw, 'lastMessage', 'last_message'),
  );
  if (lastMessage) updates.lastMessage = lastMessage;

  const updatedAt = pick<string>(raw, 'updatedAt', 'updated_at');
  if (updatedAt != null) updates.updatedAt = updatedAt;

  const userName = pick<string | null>(raw, 'userName', 'user_name');
  if (userName !== undefined && userName !== null) updates.userName = userName;

  const userPortraitUrl = pick<string | null>(
    raw,
    'userPortraitUrl',
    'user_portrait_url',
  );
  if (userPortraitUrl !== undefined && userPortraitUrl !== null) {
    updates.userPortraitUrl = userPortraitUrl;
  }

  const folderId = pick<string | null>(raw, 'folderId', 'folder_id');
  if (folderId !== undefined) updates.folderId = folderId;

  const sessionType = pick<string>(raw, 'sessionType', 'session_type');
  if (sessionType !== undefined) updates.sessionType = sessionType;

  const nodeId = pick<string>(raw, 'nodeId', 'node_id');
  if (nodeId !== undefined) updates.nodeId = nodeId;

  const agentId = pick<string | null>(raw, 'agentId', 'agent_id');
  if (agentId !== undefined && agentId !== null) updates.agentId = agentId;

  const agentName = pick<string | null>(raw, 'agentName', 'agent_name');
  if (agentName !== undefined && agentName !== null) updates.agentName = agentName;

  const agentPortraitUrl = pick<string | null>(
    raw,
    'agentPortraitUrl',
    'agent_portrait_url',
  );
  if (agentPortraitUrl !== undefined && agentPortraitUrl !== null) {
    updates.agentPortraitUrl = agentPortraitUrl;
  }

  const backend = pick<string | null>(raw, 'backend');
  if (backend !== undefined && backend !== null) updates.backend = backend;

  const modelPreset = pick<string | null>(raw, 'modelPreset', 'model_preset');
  if (modelPreset !== undefined) updates.modelPreset = modelPreset;

  const reasoningEffort = pick<string | null>(
    raw,
    'reasoningEffort',
    'reasoning_effort',
  );
  if (reasoningEffort !== undefined) updates.reasoningEffort = reasoningEffort;

  const modelLabel = pick<string | null>(raw, 'modelLabel', 'model_label');
  if (modelLabel !== undefined) updates.modelLabel = modelLabel;

  return updates;
}

/** chat SSE session_ended payload를 guarded store action 입력으로 정규화한다. */
export function toSessionEndedReconciliation(
  raw: unknown,
): SessionEndedReconciliation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const status = pick<string>(record, 'status');
  const lastEventId = normalizeEventId(record._event_id);
  if (!status || lastEventId === undefined || lastEventId === 0) return null;

  const result: SessionEndedReconciliation = { status, lastEventId };
  const terminationReason = nullableStringField(
    record,
    'terminationReason',
    'termination_reason',
  );
  if (terminationReason !== undefined) {
    result.terminationReason = terminationReason;
  }
  const terminationDetail = nullableStringField(
    record,
    'terminationDetail',
    'termination_detail',
  );
  if (terminationDetail !== undefined) {
    result.terminationDetail = terminationDetail;
  }
  return result;
}

import type { useTranslation } from 'react-i18next';
import type { PersistentSession } from './persistent-sessions';

export type WebhookTranslate = ReturnType<typeof useTranslation>['t'];

export type WebhookAuthMode = 'key' | 'signature';
export type InboundWebhookState = 'active' | 'expired' | 'revoked';

export interface InboundRecentSummary {
  count_24h: number;
  failed_24h: number;
  last_received_at: string | null;
}

export interface InboundWebhook {
  id: string;
  label: string;
  target_session_id: string;
  auth_mode: WebhookAuthMode;
  preamble: string | null;
  url: string;
  /** 발급 응답에 아직 없다. 있을 때만 「헤더 없이 보낼 주소」 행을 그린다. */
  key_url?: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  state: InboundWebhookState;
  recent?: InboundRecentSummary;
}

export interface IssuedInboundWebhook extends InboundWebhook {
  secret: string;
}

export interface InboundWebhookIssue {
  target_session_id: string;
  label: string;
  auth_mode: WebhookAuthMode;
  preamble: string | null;
  expires_in_seconds: number | null;
}

export type InboundRequestStatus = 'accepted' | 'processing' | 'completed' | 'failed';
export type InboundSessionState = 'running' | 'idle' | 'error' | 'stopped';

export interface InboundRequest {
  request_id: string;
  status: InboundRequestStatus;
  session: { state: InboundSessionState };
  received_at: string;
}

export type OutboundEventType = 'session.reply' | 'session.question' | 'session.failed' | 'session.ended';
export type DeliveryState = 'pending' | 'delivered' | 'dead';
export type RedeliverOutcome = 'delivered' | 'retrying' | 'dead' | 'skipped';

export interface OutboundSubscription {
  id: string;
  label: string;
  target_session_id: string;
  event_types: OutboundEventType[];
  url: string;
  active: boolean;
  disabled_reason: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
  /** 목록 응답에서만 온다. 24시간 창의 실패 수. */
  recent_failures?: number;
}

export interface OutboundWebhookCreate {
  target_session_id: string;
  label: string;
  url: string;
  event_types: OutboundEventType[];
}

export interface OutboundWebhookCreated {
  subscription: OutboundSubscription;
  signing_secret: string;
}

export interface WebhookDelivery {
  id: string;
  event_id: number;
  event_type: OutboundEventType;
  state: DeliveryState;
  attempt_count: number;
  next_attempt_at: string;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export class WebhooksError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly reason?: string,
  ) {
    super(`HTTP ${status}`);
    this.name = 'WebhooksError';
  }
}

async function failure(response: Response): Promise<never> {
  const body = await response.json().catch(() => null) as { error?: unknown; reason?: unknown } | null;
  throw new WebhooksError(
    response.status,
    typeof body?.error === 'string' ? body.error : undefined,
    typeof body?.reason === 'string' ? body.reason : undefined,
  );
}

export function createWebhooksApi(request: typeof fetch = fetch) {
  async function call<T>(path: string, method: string, body?: object): Promise<T> {
    const response = await request(path, {
      credentials: 'same-origin',
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!response.ok) return failure(response);
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }
  const outbound = '/api/webhooks/outbound';
  return {
    listInbound: () => call<InboundWebhook[]>('/api/webhooks/inbound', 'GET'),
    issueInbound: (input: InboundWebhookIssue) => call<IssuedInboundWebhook>('/api/webhooks/inbound', 'POST', {
      ...input,
      // 빈 칸과 공백뿐인 앞글은 null 로 보낸다. 빈 문자열을 보내면 서버가
      // 기본 글 대신 빈 앞글을 넣는다.
      preamble: input.preamble !== null && input.preamble.trim() !== '' ? input.preamble : null,
    }),
    listInboundRequests: (id: string, limit = 20) =>
      call<{ items: InboundRequest[] }>(`/api/webhooks/inbound/${encodeURIComponent(id)}/requests?limit=${limit}`, 'GET')
        .then(result => result.items),
    revokeInbound: (id: string) => call<InboundWebhook>(`/api/webhooks/inbound/${encodeURIComponent(id)}`, 'DELETE'),
    listOutbound: () => call<{ subscriptions: OutboundSubscription[] }>(outbound, 'GET').then(result => result.subscriptions),
    createOutbound: (input: OutboundWebhookCreate) => call<OutboundWebhookCreated>(outbound, 'POST', input),
    listDeliveries: (id: string, state?: DeliveryState) =>
      call<{ deliveries: WebhookDelivery[] }>(
        `${outbound}/${encodeURIComponent(id)}/deliveries${state === undefined ? '' : `?state=${state}`}`,
        'GET',
      ).then(result => result.deliveries),
    redeliver: (id: string, deliveryId: string) =>
      call<{ outcome: RedeliverOutcome }>(
        `${outbound}/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/redeliver`,
        'POST',
      ).then(result => result.outcome),
    setOutboundActive: (id: string, active: boolean) =>
      call<{ subscription: OutboundSubscription }>(`${outbound}/${encodeURIComponent(id)}`, 'PATCH', { active })
        .then(result => result.subscription),
    deleteOutbound: (id: string) => call<void>(`${outbound}/${encodeURIComponent(id)}`, 'DELETE'),
  };
}

export type WebhooksApi = ReturnType<typeof createWebhooksApi>;

export function sessionName(session: Pick<PersistentSession, 'display_name' | 'agent_name'>, t: WebhookTranslate): string {
  return session.display_name || t('webhooks.common.sessionName', { agent: session.agent_name || t('webhooks.common.agent') });
}

export function sessionShortName(id: string, t: WebhookTranslate): string {
  return t('webhooks.common.sessionIdShort', { id: id.slice(0, 8) });
}

export function inboundRequestStatusLabel(request: Pick<InboundRequest, 'status' | 'session'>, t: WebhookTranslate): string {
  switch (request.status) {
    case 'accepted': return t('webhooks.inbound.accepted');
    case 'completed': return t('webhooks.inbound.completed');
    case 'failed': return t('webhooks.inbound.failed');
    case 'processing': return t(request.session.state === 'running' ? 'webhooks.inbound.processing' : 'webhooks.inbound.stalled');
    default: return request.status;
  }
}

export function deliveryStateLabel(state: DeliveryState, t: WebhookTranslate): string {
  if (state === 'delivered') return t('webhooks.outbound.delivered');
  return t(state === 'pending' ? 'webhooks.outbound.pending' : 'webhooks.outbound.failed');
}

/** attempt_count 는 일시 실패에서만 오른다. 첫 시도 4xx 로 죽은 건은 0이라 싣지 않는다. */
export function deliveryAttemptText(attemptCount: number, t: WebhookTranslate): string | null {
  return attemptCount >= 1 ? t('webhooks.outbound.attempts', { count: attemptCount }) : null;
}

const challengeReasons = new Set([
  'verification_failed', 'timeout', 'dns_failed', 'network_error', 'unsafe_callback', 'redirect_forbidden', 'response_too_large',
]);

export function challengeReasonText(reason: string | undefined, t: WebhookTranslate): string {
  return t(`webhooks.outbound.challenge.${reason !== undefined && challengeReasons.has(reason) ? reason : 'unknown'}`);
}

const lastErrors = new Set([
  'timeout', 'dns_failed', 'network_error', 'unsafe_callback', 'redirect_forbidden', 'response_too_large',
  'target_missing', 'access_revoked', 'disabled_while_pending',
]);

export function lastErrorText(code: string, t: WebhookTranslate): string {
  const http = /^http_(\d{3})$/.exec(code);
  if (http !== null) return t('webhooks.outbound.response', { status: http[1] });
  return lastErrors.has(code) ? t(`webhooks.outbound.deliveryError.${code}`) : code;
}

export function lastReceivedLabel(value: string | null, locale: string, t: WebhookTranslate, now = Date.now()): string {
  if (!value) return t('webhooks.inbound.neverReceived');
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60000));
  if (minutes < 60) return t('webhooks.inbound.receivedMinutes', { count: minutes });
  if (minutes < 1440) return t('webhooks.inbound.receivedHours', { count: Math.floor(minutes / 60) });
  if (minutes < 2880) return t('webhooks.inbound.receivedYesterday');
  if (minutes < 10080) return t('webhooks.inbound.receivedDays', { count: Math.floor(minutes / 1440) });
  const date = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(new Date(value));
  return t('webhooks.inbound.receivedDate', { date });
}

const eventTypeKeys = {
  'session.reply': 'webhooks.outbound.reply',
  'session.question': 'webhooks.outbound.question',
  'session.failed': 'webhooks.outbound.sessionFailed',
  'session.ended': 'webhooks.outbound.sessionEnded',
} satisfies Record<OutboundEventType, string>;

export function eventTypeLabel(type: OutboundEventType, t: WebhookTranslate): string {
  return Object.hasOwn(eventTypeKeys, type) ? t(eventTypeKeys[type]) : type;
}

export function eventTypesLabel(types: readonly OutboundEventType[], t: WebhookTranslate): string {
  const order = Object.keys(eventTypeKeys) as OutboundEventType[];
  return order.filter(type => types.includes(type)).map(type => eventTypeLabel(type, t)).join(', ');
}

export function outboundDisabledText(
  subscription: Pick<OutboundSubscription, 'active' | 'disabled_reason'>,
  t: WebhookTranslate,
): { text: string; danger: boolean } | null {
  if (subscription.active) return null;
  if (subscription.disabled_reason === 'consecutive_failures') return { text: t('webhooks.outbound.offForFailures'), danger: true };
  if (subscription.disabled_reason === 'gone') return { text: t('webhooks.outbound.offForGone'), danger: true };
  return { text: t('webhooks.outbound.off'), danger: false };
}

export function outboundDisabledDetail(reason: string | null, t: WebhookTranslate): string | null {
  if (reason === 'consecutive_failures') return t('webhooks.outbound.offForFailuresDetail');
  if (reason === 'gone') return t('webhooks.outbound.offForGoneDetail');
  return null;
}

/** 「12월 18일 오후 2:10」 꼴. 올해가 아니면 연도를 붙인다. */
export function formatStamp(value: string, locale: string, withTime = false, now = Date.now()): string {
  const date = new Date(value);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    ...(sameYear ? {} : { year: 'numeric' as const }),
    month: 'long',
    day: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(date);
}

/** 기록 시각. 오늘이면 「오후 3:14」, 아니면 날짜와 시각, 올해가 아니면 연도까지. */
export function formatClock(value: string, locale: string, now = Date.now()): string {
  const date = new Date(value);
  const today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' as const }), month: 'long', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

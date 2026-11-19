/**
 * 설정 창 「웹훅」 탭의 서버 호출과 화면 문구 대응.
 *
 * 칸 이름과 응답 모양은 main 의 orch-server-ts/src/webhooks/*.ts,
 * external_access/external_input_service.ts 를 그대로 따른다. 서버의 영문
 * detail 은 화면에 내지 않고 상태 코드와 error, reason, last_error 코드로
 * 이 파일의 표를 거쳐 우리말 문구가 된다.
 *
 * 비밀(secret, signing_secret, key_url)은 반환값으로만 넘기고 로그, 전역
 * 상태, localStorage, 쿼리 캐시에 남기지 않는다.
 */

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

const inboundCodes: Record<string, string> = {
  accepted: '접수됨',
  completed: '완료',
  failed: '전달 실패',
};

/** 처리 중인 요청은 세션이 도는 중일 때만 「처리 중」이다. 멈춘 세션은 마감 없이 멈춤. */
export function inboundRequestStatusLabel(request: Pick<InboundRequest, 'status' | 'session'>): string {
  if (request.status === 'processing') {
    return request.session.state === 'running' ? '처리 중' : '마감 없이 멈춤';
  }
  return inboundCodes[request.status] ?? request.status;
}

export function deliveryStateLabel(state: DeliveryState): string {
  return state === 'delivered' ? '전달됨' : state === 'pending' ? '대기' : '실패';
}

/** attempt_count 는 일시 실패에서만 오른다. 첫 시도 4xx 로 죽은 건은 0이라 싣지 않는다. */
export function deliveryAttemptText(attemptCount: number): string | null {
  return attemptCount >= 1 ? `실패 ${attemptCount}번` : null;
}

const challengeReasons: Record<string, string> = {
  verification_failed: '주소가 challenge를 돌려주지 않았습니다.',
  timeout: '주소가 10초 안에 답하지 않았습니다.',
  dns_failed: '주소의 호스트를 찾지 못했습니다.',
  network_error: '주소에 연결하지 못했습니다.',
  unsafe_callback: '공개된 https 주소만 등록할 수 있습니다.',
  redirect_forbidden: '주소가 다른 곳으로 넘겼습니다. 최종 주소를 넣으세요.',
  response_too_large: '주소의 응답이 너무 큽니다.',
};

export function challengeReasonText(reason: string | undefined): string {
  return (reason !== undefined ? challengeReasons[reason] : undefined) ?? '주소를 확인하지 못했습니다.';
}

const lastErrors: Record<string, string> = {
  timeout: '응답 시간 초과',
  dns_failed: '주소를 찾지 못함',
  network_error: '연결 실패',
  unsafe_callback: '허용되지 않는 주소',
  redirect_forbidden: '다른 곳으로 넘김',
  response_too_large: '응답이 너무 큼',
  target_missing: '대상 세션 없음',
  access_revoked: '세션 접근 권한 없음',
  disabled_while_pending: '꺼져 있던 동안 대기',
};

/** 표에 없는 코드는 코드 낱말을 그대로 보인다. 알 수 없는 실패를 덮으면 단서가 사라진다. */
export function lastErrorText(code: string): string {
  const http = /^http_(\d{3})$/.exec(code);
  if (http !== null) return `응답 ${http[1]}`;
  return lastErrors[code] ?? code;
}

export function lastReceivedLabel(value: string | null, now = Date.now()): string {
  if (!value) return '아직 받지 않음';
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60000));
  if (minutes < 60) return `마지막 수신 ${minutes}분 전`;
  if (minutes < 1440) return `마지막 수신 ${Math.floor(minutes / 60)}시간 전`;
  if (minutes < 2880) return '마지막 수신 어제';
  if (minutes < 10080) return `마지막 수신 ${Math.floor(minutes / 1440)}일 전`;
  return `마지막 수신 ${new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' }).format(new Date(value))}`;
}

const eventTypeLabels: Record<OutboundEventType, string> = {
  'session.reply': '답변',
  'session.question': '질문',
  'session.failed': '세션 실패',
  'session.ended': '세션 끝남',
};

const eventTypeOrder: OutboundEventType[] = ['session.reply', 'session.question', 'session.failed', 'session.ended'];

export function eventTypeLabel(type: OutboundEventType): string {
  return eventTypeLabels[type] ?? type;
}

export function eventTypesLabel(types: readonly OutboundEventType[]): string {
  return eventTypeOrder.filter(type => types.includes(type)).map(eventTypeLabel).join(', ');
}

/** 꺼진 구독의 행 메타. 켜져 있으면 null. */
export function outboundDisabledText(
  subscription: Pick<OutboundSubscription, 'active' | 'disabled_reason'>,
): { text: string; danger: boolean } | null {
  if (subscription.active) return null;
  if (subscription.disabled_reason === 'consecutive_failures') return { text: '연속 실패로 꺼짐', danger: true };
  if (subscription.disabled_reason === 'gone') return { text: '주소가 거절해 꺼짐', danger: true };
  return { text: '꺼짐', danger: false };
}

/** 상세 창의 꺼진 사유 문장. user_disabled 와 그 밖은 사유 줄이 없다. */
export function outboundDisabledDetail(reason: string | null): string | null {
  if (reason === 'consecutive_failures') return '연속으로 20번 실패해 꺼졌습니다.';
  if (reason === 'gone') return '주소가 410으로 거절해 꺼졌습니다.';
  return null;
}

/** 「12월 18일 오후 2:10」 꼴. 올해가 아니면 연도를 붙인다. */
export function formatStamp(value: string, withTime = false, now = Date.now()): string {
  const date = new Date(value);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat('ko-KR', {
    ...(sameYear ? {} : { year: 'numeric' as const }),
    month: 'long',
    day: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(date);
}

/** 기록 시각. 오늘이면 「오후 3:14」, 아니면 날짜와 시각, 올해가 아니면 연도까지. */
export function formatClock(value: string, now = Date.now()): string {
  const date = new Date(value);
  const today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  return new Intl.DateTimeFormat('ko-KR', {
    ...(sameDay ? {} : { ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' as const }), month: 'long', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

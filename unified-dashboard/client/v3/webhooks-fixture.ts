import { accessLinkSessions } from './access-links-fixture';
import type { InboundRequest, InboundWebhook, OutboundEventType, OutboundSubscription, WebhookDelivery } from '../lib/webhooks-api';

/**
 * 검수 창(대화 갤러리)의 설정 창 「웹훅」 탭 견본. 저장은 이 전송 안에서만 일어난다.
 * 자료의 꼴은 시안 6절을 따른다: PAS 8개, 80자 발신자 이름, 지난 웹훅, 연속 실패로 꺼진 구독,
 * 요청 다섯 상태, 전달 세 상태.
 */
const at = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString();
const longName = '아주 긴 이름을 가진 외부 수집 서비스 '.repeat(6).slice(0, 80);
const events = (list: OutboundEventType[]) => list;
const subscription = (item: Omit<OutboundSubscription, 'consecutive_failures' | 'created_at' | 'updated_at'> & Partial<OutboundSubscription>): OutboundSubscription => ({
  consecutive_failures: 0,
  created_at: at(-8 * 1440),
  updated_at: at(-60),
  ...item,
});

export function createWebhooksFixture() {
  const session = (index: number) => accessLinkSessions[index]!.session_id;
  let inbound: InboundWebhook[] = [
    {
      id: 'inbound-mail', label: 'n8n 메일 요약', target_session_id: session(0), auth_mode: 'key', preamble: null,
      url: 'https://soulstream.example.test/api/webhooks/inbound/inbound-mail/' + 'A'.repeat(20),
      created_at: at(-5 * 1440), expires_at: null, revoked_at: null, last_used_at: at(-3), state: 'active',
      recent: { count_24h: 12, failed_24h: 2, last_received_at: at(-3) },
    },
    {
      id: 'inbound-long', label: longName, target_session_id: session(7), auth_mode: 'signature', preamble: '자료로 다루십시오.',
      url: 'https://soulstream.example.test/api/webhooks/inbound/inbound-long/' + 'B'.repeat(20),
      created_at: at(-30 * 1440), expires_at: at(335 * 1440), revoked_at: null, last_used_at: null, state: 'active',
      recent: { count_24h: 0, failed_24h: 0, last_received_at: null },
    },
    {
      id: 'inbound-expired', label: '지난 수집 웹훅', target_session_id: session(2), auth_mode: 'key', preamble: null,
      url: 'https://soulstream.example.test/api/webhooks/inbound/inbound-expired/' + 'C'.repeat(20),
      created_at: at(-40 * 1440), expires_at: at(-1 * 1440), revoked_at: null, last_used_at: at(-2 * 1440), state: 'expired',
      recent: { count_24h: 0, failed_24h: 0, last_received_at: at(-2 * 1440) },
    },
    {
      id: 'inbound-revoked', label: '옛 조사 웹훅', target_session_id: session(3), auth_mode: 'key', preamble: null,
      url: 'https://soulstream.example.test/api/webhooks/inbound/inbound-revoked/' + 'D'.repeat(20),
      created_at: at(-20 * 1440), expires_at: null, revoked_at: at(-3 * 1440), last_used_at: at(-4 * 1440), state: 'revoked',
      recent: { count_24h: 0, failed_24h: 0, last_received_at: at(-4 * 1440) },
    },
  ];
  const requests: InboundRequest[] = [
    { request_id: 'req-5f2a9c1e-1111-4a11-9e33-0d0f2c7d9a01', status: 'accepted', session: { state: 'idle' }, received_at: at(-4) },
    { request_id: 'req-5f2a9c1e-2222-4a11-9e33-0d0f2c7d9a02', status: 'processing', session: { state: 'running' }, received_at: at(-18) },
    { request_id: 'req-5f2a9c1e-3333-4a11-9e33-0d0f2c7d9a03', status: 'processing', session: { state: 'stopped' }, received_at: at(-95) },
    { request_id: 'req-5f2a9c1e-4444-4a11-9e33-0d0f2c7d9a04', status: 'completed', session: { state: 'idle' }, received_at: at(-26 * 60) },
    { request_id: 'req-5f2a9c1e-5555-4a11-9e33-0d0f2c7d9a05', status: 'failed', session: { state: 'error' }, received_at: at(-2 * 1440) },
  ];
  let outbound: OutboundSubscription[] = [
    subscription({ id: 'outbound-summary', label: '요약 받는 주소', target_session_id: session(1), event_types: events(['session.reply', 'session.question', 'session.failed']), url: 'https://push.example.net/hooks/summary/monthly', active: true, disabled_reason: null, recent_failures: 1 }),
    subscription({ id: 'outbound-team', label: '팀 알림', target_session_id: session(4), event_types: events(['session.failed', 'session.ended']), url: 'https://team.example.org/incoming/soulstream', active: true, disabled_reason: null, recent_failures: 0 }),
    subscription({ id: 'outbound-off', label: '꺼진 수집기', target_session_id: session(5), event_types: events(['session.reply']), url: 'https://old.example.net/collect', active: false, disabled_reason: 'consecutive_failures', consecutive_failures: 20, recent_failures: 20 }),
  ];
  let deliveries: Record<string, WebhookDelivery[]> = {
    'outbound-summary': [
      { id: 'delivery-1', event_id: 101, event_type: 'session.reply', state: 'delivered', attempt_count: 0, next_attempt_at: at(-20), last_status: 200, last_error: null, created_at: at(-20), delivered_at: at(-20) },
      { id: 'delivery-2', event_id: 102, event_type: 'session.question', state: 'pending', attempt_count: 2, next_attempt_at: at(20), last_status: 503, last_error: null, created_at: at(-10), delivered_at: null },
      { id: 'delivery-3', event_id: 103, event_type: 'session.failed', state: 'dead', attempt_count: 3, next_attempt_at: at(-5), last_status: 503, last_error: null, created_at: at(-60), delivered_at: null },
      { id: 'delivery-4', event_id: 104, event_type: 'session.reply', state: 'dead', attempt_count: 0, next_attempt_at: at(-30), last_status: null, last_error: 'timeout', created_at: at(-90), delivered_at: null },
    ],
    'outbound-team': [
      { id: 'delivery-5', event_id: 105, event_type: 'session.ended', state: 'delivered', attempt_count: 0, next_attempt_at: at(-40), last_status: 204, last_error: null, created_at: at(-40), delivered_at: at(-40) },
    ],
    'outbound-off': [
      { id: 'delivery-6', event_id: 106, event_type: 'session.reply', state: 'dead', attempt_count: 0, next_attempt_at: at(-120), last_status: null, last_error: 'disabled_while_pending', created_at: at(-200), delivered_at: null },
    ],
  };
  let serial = 0;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'https://sample.invalid');
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (path === '/api/webhooks/inbound') {
      if (method === 'POST') {
        serial += 1;
        const id = `inbound-sample-${serial}`;
        const created: InboundWebhook = {
          id, label: String(body.label), target_session_id: String(body.target_session_id),
          auth_mode: body.auth_mode === 'signature' ? 'signature' : 'key',
          preamble: typeof body.preamble === 'string' ? body.preamble : null,
          url: `https://soulstream.example.test/api/webhooks/inbound/${id}/${'E'.repeat(20)}`,
          created_at: at(0), expires_at: typeof body.expires_in_seconds === 'number' ? at(body.expires_in_seconds / 60) : null,
          revoked_at: null, last_used_at: null, state: 'active',
        };
        inbound = [created, ...inbound];
        return Response.json({ ...created, secret: 'fake-inbound-secret-' + 'F'.repeat(20) }, { status: 201 });
      }
      return Response.json(inbound);
    }
    let match = /^\/api\/webhooks\/inbound\/([^/]+)\/requests$/.exec(path);
    if (match && method === 'GET') return Response.json({ items: requests });
    match = /^\/api\/webhooks\/inbound\/([^/]+)$/.exec(path);
    if (match && method === 'DELETE') {
      const id = decodeURIComponent(match[1]!);
      const item = inbound.find(entry => entry.id === id);
      if (!item) return Response.json({ detail: 'Not found' }, { status: 404 });
      item.state = 'revoked';
      item.revoked_at = at(0);
      return Response.json(item);
    }
    if (path === '/api/webhooks/outbound') {
      if (method === 'POST') {
        serial += 1;
        const created = subscription({
          id: `outbound-sample-${serial}`, label: String(body.label), target_session_id: String(body.target_session_id),
          event_types: (body.event_types as OutboundEventType[] | undefined) ?? ['session.reply'],
          url: String(body.url), active: true, disabled_reason: null, recent_failures: 0,
          created_at: at(0), updated_at: at(0),
        });
        outbound = [created, ...outbound];
        deliveries[created.id] = [];
        return Response.json({ subscription: created, signing_secret: 'whsec_fake_' + 'G'.repeat(32) }, { status: 201 });
      }
      return Response.json({ subscriptions: outbound });
    }
    match = /^\/api\/webhooks\/outbound\/([^/]+)\/deliveries$/.exec(path);
    if (match && method === 'GET') {
      const id = decodeURIComponent(match[1]!);
      const state = url.searchParams.get('state');
      return Response.json({ deliveries: (deliveries[id] ?? []).filter(item => state === null || item.state === state) });
    }
    match = /^\/api\/webhooks\/outbound\/([^/]+)\/deliveries\/([^/]+)\/redeliver$/.exec(path);
    if (match && method === 'POST') {
      const id = decodeURIComponent(match[1]!);
      const deliveryId = decodeURIComponent(match[2]!);
      const item = outbound.find(entry => entry.id === id);
      if (!item) return Response.json({ detail: 'Not found' }, { status: 404 });
      if (!item.active) return Response.json({ error: 'subscription_inactive' }, { status: 409 });
      const delivery = (deliveries[id] ?? []).find(entry => entry.id === deliveryId);
      if (!delivery || delivery.state !== 'dead') return Response.json({ outcome: 'skipped' });
      delivery.state = 'delivered';
      delivery.last_status = 200;
      delivery.last_error = null;
      delivery.delivered_at = at(0);
      return Response.json({ outcome: 'delivered' });
    }
    match = /^\/api\/webhooks\/outbound\/([^/]+)$/.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      const item = outbound.find(entry => entry.id === id);
      if (!item) return Response.json({ detail: 'Not found' }, { status: 404 });
      if (method === 'PATCH') {
        item.active = body.active === true;
        item.disabled_reason = item.active ? null : 'user_disabled';
        item.consecutive_failures = item.active ? 0 : item.consecutive_failures;
        item.updated_at = at(0);
        if (!item.active) {
          for (const delivery of deliveries[id] ?? []) {
            if (delivery.state === 'pending') { delivery.state = 'dead'; delivery.last_error = 'disabled_while_pending'; }
          }
        }
        return Response.json({ subscription: item });
      }
      if (method === 'DELETE') {
        outbound = outbound.filter(entry => entry.id !== id);
        delete deliveries[id];
        return new Response(null, { status: 204 });
      }
    }
    return Response.json({ detail: 'Not found' }, { status: 404 });
  };
}

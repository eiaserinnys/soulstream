import { createI18n } from '@soulstream/i18n';
import { describe, expect, it, vi } from 'vitest';
import {
  challengeReasonText,
  createWebhooksApi,
  deliveryAttemptText,
  deliveryStateLabel,
  eventTypesLabel,
  formatClock,
  formatStamp,
  inboundRequestStatusLabel,
  lastErrorText,
  lastReceivedLabel,
  outboundDisabledDetail,
  outboundDisabledText,
  WebhooksError,
} from './webhooks-api';

const subscription = {
  id: 'sub', label: '요약', target_session_id: '123', event_types: ['session.reply' as const], url: 'https://example.test/hook',
  active: true, disabled_reason: null, consecutive_failures: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};

describe('webhooks API', () => {
  it('uses the expected paths, methods, bodies and credentials', async () => {
    const issue = { id: 'one', label: '수집', target_session_id: '123', auth_mode: 'key' as const, preamble: '앞글', url: 'https://example.test/api/hooks/one', created_at: '2026-01-01T00:00:00Z', expires_at: null, revoked_at: null, last_used_at: null, state: 'active' as const, secret: 'fake-secret' };
    const delivery = { id: 'd', event_id: 1, event_type: 'session.reply' as const, state: 'dead' as const, attempt_count: 2, next_attempt_at: '2026-01-01T00:00:00Z', last_status: 503, last_error: null, created_at: '2026-01-01T00:00:00Z', delivered_at: null };
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json([issue]))
      .mockResolvedValueOnce(Response.json(issue, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ items: [{ request_id: 'r', status: 'accepted', session: { state: 'idle' }, received_at: '2026-01-01T00:00:00Z' }] }))
      .mockResolvedValueOnce(Response.json(issue))
      .mockResolvedValueOnce(Response.json({ subscriptions: [subscription] }))
      .mockResolvedValueOnce(Response.json({ subscription, signing_secret: 'fake-signing' }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ deliveries: [delivery] }))
      .mockResolvedValueOnce(Response.json({ outcome: 'delivered' }))
      .mockResolvedValueOnce(Response.json({ subscription }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createWebhooksApi(request);
    expect(await api.listInbound()).toEqual([issue]);
    const body = { target_session_id: '123', label: '수집', auth_mode: 'key' as const, preamble: '앞글', expires_in_seconds: null };
    expect((await api.issueInbound(body)).secret).toBe('fake-secret');
    expect((await api.listInboundRequests('a/b')).length).toBe(1);
    expect(await api.revokeInbound('a/b')).toEqual(issue);
    expect(await api.listOutbound()).toEqual([subscription]);
    expect((await api.createOutbound({ target_session_id: '123', label: '요약', url: 'https://example.test/hook', event_types: ['session.reply'] })).signing_secret).toBe('fake-signing');
    expect(await api.listDeliveries('sub', 'dead')).toEqual([delivery]);
    expect(await api.redeliver('sub', 'd')).toBe('delivered');
    expect(await api.setOutboundActive('sub', false)).toEqual(subscription);
    expect(await api.deleteOutbound('sub')).toBeUndefined();
    expect(request.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      ['/api/webhooks/inbound', 'GET'],
      ['/api/webhooks/inbound', 'POST'],
      ['/api/webhooks/inbound/a%2Fb/requests?limit=20', 'GET'],
      ['/api/webhooks/inbound/a%2Fb', 'DELETE'],
      ['/api/webhooks/outbound', 'GET'],
      ['/api/webhooks/outbound', 'POST'],
      ['/api/webhooks/outbound/sub/deliveries?state=dead', 'GET'],
      ['/api/webhooks/outbound/sub/deliveries/d/redeliver', 'POST'],
      ['/api/webhooks/outbound/sub', 'PATCH'],
      ['/api/webhooks/outbound/sub', 'DELETE'],
    ]);
    expect(request.mock.calls[1]![1]).toMatchObject({ credentials: 'same-origin', body: JSON.stringify(body) });
    expect(request.mock.calls[8]![1]).toMatchObject({ credentials: 'same-origin', body: JSON.stringify({ active: false }) });
    expect(request.mock.calls[1]![1]).toHaveProperty('headers', { 'Content-Type': 'application/json' });
  });

  it('sends blank or whitespace-only preambles as null and keeps expiry seconds', async () => {
    const request = vi.fn().mockImplementation(async () => Response.json({}, { status: 201 }));
    const api = createWebhooksApi(request);
    const base = { target_session_id: '123', label: '이름', auth_mode: 'signature' as const, expires_in_seconds: 86400 };
    await api.issueInbound({ ...base, preamble: '   ' });
    await api.issueInbound({ ...base, preamble: '' });
    await api.issueInbound({ ...base, preamble: null });
    await api.issueInbound({ ...base, preamble: ' 남길 글 ' });
    const bodies = request.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map(body => body.preamble)).toEqual([null, null, null, ' 남길 글 ']);
    expect(bodies[0].expires_in_seconds).toBe(86400);
  });

  it('exposes status, error and reason codes without the server detail', async () => {
    const api = createWebhooksApi(vi.fn().mockResolvedValue(Response.json({ error: 'challenge_failed', reason: 'timeout', detail: 'private detail' }, { status: 422 })));
    const error = await api.createOutbound({ target_session_id: '1', label: 'x', url: 'https://x.test', event_types: ['session.reply'] }).catch(cause => cause);
    expect(error).toBeInstanceOf(WebhooksError);
    expect(error.status).toBe(422);
    expect(error.code).toBe('challenge_failed');
    expect(error.reason).toBe('timeout');
    expect(error.message).not.toContain('private detail');
  });

  it('keeps the status when the failure body is not JSON', async () => {
    const api = createWebhooksApi(vi.fn().mockResolvedValue(new Response('oops', { status: 503 })));
    const error = await api.listOutbound().catch(cause => cause);
    expect(error).toBeInstanceOf(WebhooksError);
    expect(error.status).toBe(503);
    expect(error.code).toBeUndefined();
  });
});

describe('webhook text mapping', () => {
  const { t } = createI18n('ko');
  it('maps the five inbound request states', () => {
    const state = (status: 'accepted' | 'processing' | 'completed' | 'failed', session: 'running' | 'idle' | 'error' | 'stopped') =>
      inboundRequestStatusLabel({ status, session: { state: session } }, t);
    expect(state('accepted', 'idle')).toBe('접수됨');
    expect(state('processing', 'running')).toBe('처리 중');
    expect(state('processing', 'idle')).toBe('마감 없이 멈춤');
    expect(state('processing', 'error')).toBe('마감 없이 멈춤');
    expect(state('processing', 'stopped')).toBe('마감 없이 멈춤');
    expect(state('completed', 'idle')).toBe('완료');
    expect(state('failed', 'idle')).toBe('전달 실패');
  });
  it('maps delivery states and omits the failure count at zero', () => {
    expect(deliveryStateLabel('delivered', t)).toBe('전달됨');
    expect(deliveryStateLabel('pending', t)).toBe('대기');
    expect(deliveryStateLabel('dead', t)).toBe('실패');
    expect(deliveryAttemptText(0, t)).toBeNull();
    expect(deliveryAttemptText(3, t)).toBe('실패 3번');
  });
  it('maps challenge reasons and falls back for the rest', () => {
    expect(challengeReasonText('timeout', t)).toBe('주소가 10초 안에 답하지 않았습니다.');
    expect(challengeReasonText('redirect_forbidden', t)).toBe('주소가 다른 곳으로 넘겼습니다. 최종 주소를 넣으세요.');
    expect(challengeReasonText('something_else', t)).toBe('주소를 확인하지 못했습니다.');
    expect(challengeReasonText(undefined, t)).toBe('주소를 확인하지 못했습니다.');
  });
  it('maps last_error codes and keeps unknown codes as words', () => {
    expect(lastErrorText('disabled_while_pending', t)).toBe('꺼져 있던 동안 대기');
    expect(lastErrorText('access_revoked', t)).toBe('세션 접근 권한 없음');
    expect(lastErrorText('http_503', t)).toBe('응답 503');
    expect(lastErrorText('mystery_code', t)).toBe('mystery_code');
  });
  it('walks the last-received ladder', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    const ago = (minutes: number) => new Date(now - minutes * 60000).toISOString();
    expect(lastReceivedLabel(null, 'ko', t, now)).toBe('아직 받지 않음');
    expect(lastReceivedLabel(ago(3), 'ko', t, now)).toBe('마지막 수신 3분 전');
    expect(lastReceivedLabel(ago(125), 'ko', t, now)).toBe('마지막 수신 2시간 전');
    expect(lastReceivedLabel(ago(1500), 'ko', t, now)).toBe('마지막 수신 어제');
    expect(lastReceivedLabel(ago(3 * 1440), 'ko', t, now)).toBe('마지막 수신 3일 전');
    expect(lastReceivedLabel(ago(10 * 1440), 'ko', t, now)).toBe('마지막 수신 11월 8일');
  });
  it('orders event labels and explains disabled subscriptions', () => {
    expect(eventTypesLabel(['session.ended', 'session.reply', 'session.question'], t)).toBe('답변, 질문, 세션 끝남');
    expect(eventTypesLabel([], t)).toBe('');
    expect(outboundDisabledText({ active: true, disabled_reason: null }, t)).toBeNull();
    expect(outboundDisabledText({ active: false, disabled_reason: 'consecutive_failures' }, t)).toEqual({ text: '연속 실패로 꺼짐', danger: true });
    expect(outboundDisabledText({ active: false, disabled_reason: 'gone' }, t)).toEqual({ text: '주소가 거절해 꺼짐', danger: true });
    expect(outboundDisabledText({ active: false, disabled_reason: 'user_disabled' }, t)).toEqual({ text: '꺼짐', danger: false });
    expect(outboundDisabledDetail('consecutive_failures', t)).toBe('연속으로 20번 실패해 꺼졌습니다.');
    expect(outboundDisabledDetail('gone', t)).toBe('주소가 410으로 거절해 꺼졌습니다.');
    expect(outboundDisabledDetail('user_disabled', t)).toBeNull();
  });
  it('formats stamps with and without a year and clock values', () => {
    // 시각 꼴은 브라우저 시간대를 따르므로, 기대값도 같은 시간대의 지역 시각으로 만든다.
    const now = new Date(2026, 10, 18, 21, 0, 0).getTime();
    const sameYear = new Date(2026, 11, 18, 14, 10, 0).toISOString();
    expect(formatStamp(sameYear, 'ko', true, now)).toContain('12월 18일');
    expect(formatStamp(sameYear, 'ko', true, now)).not.toContain('2026');
    expect(formatStamp(new Date(2027, 0, 2, 14, 10, 0).toISOString(), 'ko', false, now)).toContain('2027');
    const afternoon = new Date(2026, 10, 18, 15, 14, 0).toISOString();
    expect(formatClock(afternoon, 'ko', now)).toContain('오후');
    expect(formatClock(afternoon, 'ko', now)).not.toContain('11월');
    expect(formatClock(new Date(2026, 10, 17, 21, 30, 0).toISOString(), 'ko', now)).toContain('11월 17일');
  });
});

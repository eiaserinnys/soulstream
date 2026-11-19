/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebhooksTab } from './WebhooksTab';
import type { InboundRequest, InboundWebhook, OutboundSubscription, RedeliverOutcome, WebhookDelivery } from '../lib/webhooks-api';

vi.mock('./CatalogSelectionField', () => ({ CatalogSelectionField: ({ label, ariaLabel, value, options, disabled, invalid, message, onValueChange }: any) => <label>{label}<select aria-label={ariaLabel} aria-invalid={invalid || undefined} value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}><option value="">고르기</option>{options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{message}</label> }));

const sessionId = '12345678-1234-4234-8234-123456789abc';
const otherId = '87654321-1234-4234-8234-123456789abc';
const makeInbound = (overrides: Partial<InboundWebhook> = {}): InboundWebhook => ({
  id: 'inbound-one', label: '수집 웹훅', target_session_id: sessionId, auth_mode: 'key', preamble: null,
  url: 'https://example.test/api/webhooks/inbound/one', created_at: '2026-01-01T00:00:00Z', expires_at: null,
  revoked_at: null, last_used_at: null, state: 'active', recent: { count_24h: 2, failed_24h: 1, last_received_at: null }, ...overrides,
});
const makeOutbound = (overrides: Partial<OutboundSubscription> = {}): OutboundSubscription => ({
  id: 'outbound-one', label: '요약 주소', target_session_id: sessionId, event_types: ['session.reply', 'session.question', 'session.failed'],
  url: 'https://push.example.net/hooks/one', active: true, disabled_reason: null, consecutive_failures: 0,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', recent_failures: 1, ...overrides,
});
const makeDelivery = (overrides: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
  id: 'delivery-one', event_id: 1, event_type: 'session.reply', state: 'dead', attempt_count: 1,
  next_attempt_at: '2026-11-18T03:20:00Z', last_status: 503, last_error: null,
  created_at: '2026-11-18T03:00:00Z', delivered_at: null, ...overrides,
});
const makeRequest = (overrides: Partial<InboundRequest> = {}): InboundRequest => ({
  request_id: 'req-1234', status: 'accepted', session: { state: 'idle' }, received_at: '2026-11-18T03:00:00Z', ...overrides,
});

let inbound: InboundWebhook[];
let outbound: OutboundSubscription[];
let deliveries: WebhookDelivery[];
let requestItems: InboundRequest[];
let inboundFail: boolean;
let outboundFail: boolean;
let sessionFail: boolean;
let requestsFail: boolean;
let inboundStatus: number;
let createStatus: number;
let challengeReason: string;
let redeliverOutcome: RedeliverOutcome;
let patchStatus: number;
let deleteStatus: number;
let issueKeyUrl: boolean;
let redeliverStatus: number;
let pendingIssue: ((response: Response) => void) | null = null;
let root: Root;
const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), 'https://sample.invalid');
  const path = url.pathname;
  const method = init?.method ?? 'GET';
  if (path === '/api/persistent-sessions') return sessionFail ? Response.json({}, { status: 503 }) : Response.json({ sessions: [{ session_id: sessionId, display_name: '✨ 영구 세션', agent_name: '로젤린' }] });
  if (path === '/api/webhooks/inbound') {
    if (method === 'POST') {
      if (pendingIssue) return new Promise<Response>(resolve => { pendingIssue = resolve; });
      if (createStatus !== 201) return Response.json({ detail: 'raw server detail' }, { status: createStatus });
      const body = JSON.parse(String(init?.body));
      return Response.json({ ...makeInbound(body), secret: 'fake-inbound-secret', ...(issueKeyUrl ? { key_url: 'https://example.test/x/fake-key/one' } : {}) }, { status: 201 });
    }
    return inboundFail ? Response.json({ detail: 'raw server detail' }, { status: 503 }) : Response.json(inbound);
  }
  if (path.endsWith('/requests')) {
    return requestsFail ? Response.json({ detail: 'raw server detail' }, { status: 503 }) : Response.json({ items: requestItems });
  }
  if (path.startsWith('/api/webhooks/inbound/') && method === 'DELETE') {
    if (inboundStatus !== 200) return Response.json({ detail: 'raw server detail' }, { status: inboundStatus });
    const id = decodeURIComponent(path.split('/').pop()!);
    inbound = inbound.map(item => item.id === id ? { ...item, state: 'revoked' as const, revoked_at: '2026-11-18T04:00:00Z' } : item);
    return Response.json(inbound.find(item => item.id === id));
  }
  if (path === '/api/webhooks/outbound') {
    if (method === 'POST') {
      if (createStatus !== 201) return Response.json(createStatus === 422 ? { error: 'challenge_failed', reason: challengeReason } : { error: 'forbidden' }, { status: createStatus });
      const body = JSON.parse(String(init?.body));
      return Response.json({ subscription: makeOutbound(body), signing_secret: 'fake-signing-secret' }, { status: 201 });
    }
    return outboundFail ? Response.json({ detail: 'raw server detail' }, { status: 503 }) : Response.json({ subscriptions: outbound });
  }
  if (path.endsWith('/redeliver')) return redeliverStatus === 200 ? Response.json({ outcome: redeliverOutcome }) : Response.json({ error: 'subscription_inactive' }, { status: redeliverStatus });
  if (path.endsWith('/deliveries')) {
    const state = url.searchParams.get('state');
    return Response.json({ deliveries: deliveries.filter(item => state === null || item.state === state) });
  }
  if (path.startsWith('/api/webhooks/outbound/')) {
    if (method === 'PATCH') {
      if (patchStatus !== 200) return Response.json({ detail: 'raw server detail' }, { status: patchStatus });
      const id = decodeURIComponent(path.split('/').pop()!);
      const body = JSON.parse(String(init?.body));
      outbound = outbound.map(item => item.id === id ? { ...item, active: body.active, disabled_reason: body.active ? null : 'user_disabled' } : item);
      return Response.json({ subscription: outbound.find(item => item.id === id) });
    }
    if (method === 'DELETE') {
      if (deleteStatus !== 204) return Response.json({ detail: 'raw server detail' }, { status: deleteStatus });
      const id = decodeURIComponent(path.split('/').pop()!);
      outbound = outbound.filter(item => item.id !== id);
      return new Response(null, { status: 204 });
    }
  }
  return Response.json({ detail: 'not found' }, { status: 404 });
});
beforeEach(() => {
  inbound = [makeInbound(), makeInbound({ id: 'inbound-past', label: '지난 웹훅', target_session_id: otherId, state: 'expired', expires_at: '2020-01-01T00:00:00Z' })];
  outbound = [makeOutbound(), makeOutbound({ id: 'outbound-off', label: '꺼진 수집기', active: false, disabled_reason: 'consecutive_failures', consecutive_failures: 20, recent_failures: 20 })];
  deliveries = [makeDelivery(), makeDelivery({ id: 'delivery-ok', state: 'delivered', last_status: 200 }), makeDelivery({ id: 'delivery-wait', state: 'pending', last_status: null })];
  requestItems = [makeRequest()];
  inboundFail = false; outboundFail = false; sessionFail = false; requestsFail = false;
  inboundStatus = 200; createStatus = 201; challengeReason = 'timeout'; redeliverOutcome = 'delivered'; patchStatus = 200; deleteStatus = 204;
  issueKeyUrl = false; redeliverStatus = 200;
  pendingIssue = null; request.mockClear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('CSS', { supports: () => false }); vi.stubGlobal('PointerEvent', MouseEvent);
  Element.prototype.scrollIntoView = vi.fn();
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(<WebhooksTab request={request}/>)); }
function button(label: string, dialog = false) {
  const scope = dialog ? document.querySelector('[role="dialog"][data-open]')! : document.body;
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent?.trim() === label && !el.closest('[data-ending-style]'));
  expect(found, label).toBeTruthy(); return found!;
}
async function click(label: string, dialog = false) { await act(async () => button(label, dialog).click()); }
function row(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.webhooks-row')].find(el => el.textContent?.includes(label));
  expect(found, label).toBeTruthy(); return found!;
}
async function clickRow(label: string) { await act(async () => row(label).click()); }
async function input(label: string, value: string, blur = false) {
  const el = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); if (blur) el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
}
async function textarea(label: string, value: string) {
  const el = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function choose(value: string, label = '대상 세션') {
  const select = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function chooseManual(id = sessionId, label = '대상 세션') { await choose('manual', label); await input('세션 ID', id); }
async function check(at: number, checked: boolean) {
  const boxes = [...document.querySelectorAll<HTMLElement>('[role="checkbox"]')];
  if (boxes[at]!.getAttribute('aria-checked') !== String(checked)) await act(async () => boxes[at]!.click());
}
const calls = (path: string, method = 'GET') => request.mock.calls.filter(([input, init]) => {
  const target = String(input);
  return (target === path || target.startsWith(path + '?')) && (init?.method ?? 'GET') === method;
});

it('loads both sections separately, folds past webhooks and falls back to short session ids', async () => {
  await render();
  expect(document.body.textContent).toContain('들어오는 웹훅');
  expect(document.body.textContent).toContain('나가는 웹훅');
  expect(document.body.textContent).toContain('✨ 영구 세션');
  const details = document.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain('지난 웹훅');
  expect(inboundFail).toBe(false);
  sessionFail = true;
  await act(async () => root.unmount());
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await render();
  expect(document.body.textContent).toContain('세션 12345678');
});

it('keeps the other section when one list fails and retries it alone', async () => {
  inboundFail = true;
  await render();
  expect(document.body.textContent).toContain('웹훅 목록을 불러오지 못했습니다.');
  expect(document.body.textContent).not.toContain('raw server detail');
  expect(document.body.textContent).toContain('요약 주소');
  expect(detailsText()).toBe('');
  inboundFail = false;
  await click('다시 시도');
  expect(document.body.textContent).toContain('수집 웹훅');
  function detailsText() { return document.querySelector('details')?.textContent ?? ''; }
});

it('locks the create button, sends trimmed fields and shows the key once', async () => {
  await render();
  await click('웹훅 만들기');
  const popup = document.querySelector('[role="dialog"][data-open]')!;
  expect(popup.classList.contains('webhooks-dialog')).toBe(true);
  const preambleLabel = [...popup.querySelectorAll('.config-advanced > label > span')].find(el => el.textContent === '앞에 붙일 글');
  expect(preambleLabel?.classList.contains('sr-only')).toBe(true);
  expect(popup.querySelector('textarea[aria-label="앞에 붙일 글"]')).toBeTruthy();
  expect(button('만들기', true).disabled).toBe(true);
  await chooseManual('bad');
  expect(button('만들기', true).disabled).toBe(true);
  await input('세션 ID', sessionId);
  expect(button('만들기', true).disabled).toBe(true);
  await input('발신자 이름', '  수집기  ');
  await choose('signature', '인증 방식');
  await choose('year', '기간');
  await textarea('앞에 붙일 글', '  자료입니다.  ');
  await click('만들기', true);
  const body = JSON.parse(String(calls('/api/webhooks/inbound', 'POST')[0]![1]?.body));
  expect(body).toEqual({ target_session_id: sessionId, label: '수집기', auth_mode: 'signature', preamble: '  자료입니다.  ', expires_in_seconds: 31536000 });
  expect(document.body.textContent).toContain('웹훅을 만들었습니다');
  expect(document.body.textContent).toContain('fake-inbound-secret');
  expect(document.body.textContent).not.toContain('헤더 없이 보낼 주소');
  await click('닫기', true);
  expect(document.body.textContent).not.toContain('fake-inbound-secret');
  expect(button('웹훅 만들기').disabled).toBe(false);
});

it('shows the key_url row only when the response has it', async () => {
  issueKeyUrl = true;
  await render();
  await click('웹훅 만들기');
  await chooseManual();
  await input('발신자 이름', '수집기');
  await click('만들기', true);
  expect(document.body.textContent).toContain('헤더 없이 보낼 주소');
  expect(document.body.textContent).toContain('https://example.test/x/fake-key/one');
});

it('shows the manual id format error and the mapped server errors without raw detail', async () => {
  await render();
  await click('웹훅 만들기');
  await choose('manual');
  await input('세션 ID', 'bad', true);
  expect(document.body.textContent).toContain('세션 ID 형식이 아닙니다.');
  await input('세션 ID', sessionId);
  await input('발신자 이름', '수집기');
  createStatus = 404;
  await click('만들기', true);
  expect(document.body.textContent).toContain('이 세션을 찾지 못했거나 열 수 없습니다.');
  for (const [status, text] of [[401, '로그인이 끝났습니다. 다시 로그인하세요.'], [422, '입력을 다시 확인하세요.'], [503, '지금은 웹훅을 만들 수 없습니다. 잠시 뒤 다시 시도하세요.']] as const) {
    createStatus = status;
    await click('만들기', true);
    expect(document.body.textContent).toContain(text);
  }
  expect(document.body.textContent).not.toContain('raw server detail');
});

it('prevents duplicate creates and drops a late response after unmount', async () => {
  await render();
  await click('웹훅 만들기');
  await chooseManual();
  await input('발신자 이름', '수집기');
  pendingIssue = () => {};
  await act(async () => { const submit = button('만들기', true); submit.click(); submit.click(); });
  expect(button('만드는 중…', true).getAttribute('aria-disabled')).toBe('true');
  expect(calls('/api/webhooks/inbound', 'POST')).toHaveLength(1);
  const resolve = pendingIssue!;
  await act(async () => root.unmount());
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => resolve(Response.json({ ...makeInbound(), secret: 'late-secret' }, { status: 201 })));
  expect(document.body.textContent).not.toContain('late-secret');
});

it('shows request states, refreshes and revokes from the detail dialog', async () => {
  requestItems = [
    makeRequest({ request_id: 'accepted' }),
    makeRequest({ request_id: 'running', status: 'processing', session: { state: 'running' } }),
    makeRequest({ request_id: 'stopped', status: 'processing', session: { state: 'stopped' } }),
    makeRequest({ request_id: 'completed', status: 'completed' }),
    makeRequest({ request_id: 'failed', status: 'failed', session: { state: 'error' } }),
  ];
  await render();
  await clickRow('수집 웹훅');
  for (const text of ['접수됨', '처리 중', '마감 없이 멈춤', '완료', '전달 실패']) expect(document.body.textContent).toContain(text);
  expect(document.body.textContent).toContain('https://example.test/api/webhooks/inbound/one');
  const reads = calls('/api/webhooks/inbound/inbound-one/requests').length;
  await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"][data-open] [aria-label="새로 고침"]')!.click());
  expect(calls('/api/webhooks/inbound/inbound-one/requests').length).toBe(reads + 1);
  await click('폐기', true);
  expect(document.body.textContent).toContain('웹훅 폐기');
  await click('폐기', true);
  expect(inbound[0]!.state).toBe('revoked');
  expect(calls('/api/webhooks/inbound')).toHaveLength(2);
  expect(document.body.textContent).not.toContain('raw server detail');
});

it('treats a missing inbound webhook on revoke as already gone', async () => {
  inboundStatus = 404;
  await render();
  await clickRow('수집 웹훅');
  await click('폐기', true);
  await click('폐기', true);
  expect(calls('/api/webhooks/inbound')).toHaveLength(2);
  expect(document.body.textContent).not.toContain('raw server detail');
});

it('shows the empty inbound request state and the record error', async () => {
  requestItems = [];
  await render();
  await clickRow('수집 웹훅');
  expect(document.body.textContent).toContain('아직 받은 요청이 없습니다.');
  requestsFail = true;
  await click('닫기', true);
  await clickRow('수집 웹훅');
  expect(document.body.textContent).toContain('요청 기록을 불러오지 못했습니다.');
});

it('locks registration until target, name, https address and one event are present', async () => {
  await render();
  await click('주소 등록');
  expect(document.querySelector('[role="dialog"][data-open]')?.classList.contains('webhooks-dialog')).toBe(true);
  const boxes = [...document.querySelectorAll<HTMLElement>('[role="checkbox"]')];
  expect(boxes.map(box => box.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true', 'false']);
  expect(button('등록', true).disabled).toBe(true);
  await chooseManual();
  await input('이름', '요약 주소');
  await click('등록', true);
  expect(calls('/api/webhooks/outbound', 'POST')).toHaveLength(0);
  await input('받을 주소', 'http://push.example.net/hook', true);
  expect(document.body.textContent).toContain('https 주소를 넣으세요.');
  await input('받을 주소', 'https://push.example.net/hook');
  expect(button('등록', true).disabled).toBe(false);
  await check(0, false); await check(1, false); await check(2, false);
  expect(document.body.textContent).toContain('하나 이상 고르세요.');
  expect(button('등록', true).disabled).toBe(true);
});

it('registers, shows the signing secret once and points challenge failures under the address', async () => {
  createStatus = 201;
  await render();
  await click('주소 등록');
  await chooseManual();
  await input('이름', '요약 주소');
  await input('받을 주소', 'https://push.example.net/hook');
  await click('등록', true);
  expect(JSON.parse(String(calls('/api/webhooks/outbound', 'POST')[0]![1]?.body))).toEqual({
    target_session_id: sessionId, label: '요약 주소', url: 'https://push.example.net/hook',
    event_types: ['session.reply', 'session.question', 'session.failed'],
  });
  expect(document.body.textContent).toContain('주소를 등록했습니다');
  expect(document.body.textContent).toContain('fake-signing-secret');
  await click('닫기', true);
  expect(document.body.textContent).not.toContain('fake-signing-secret');
  await click('주소 등록');
  await chooseManual();
  await input('이름', '요약 주소');
  await input('받을 주소', 'https://push.example.net/hook');
  createStatus = 422;
  await click('등록', true);
  expect(document.body.textContent).toContain('주소가 10초 안에 답하지 않았습니다.');
  const address = document.querySelector('[aria-label="받을 주소"]')!;
  const error = [...document.querySelectorAll('[role="alert"]')].find(el => el.textContent?.includes('10초'))!;
  expect(address.getAttribute('aria-invalid')).toBe('true');
  expect(address.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(document.body.textContent).toContain('등록할 때 확인 요청을 보냅니다.');
  expect(document.body.textContent).not.toContain('raw server detail');
});

it.each([403, 404])('shows the same target message for %s', async status => {
  createStatus = status;
  await render();
  await click('주소 등록');
  await chooseManual();
  await input('이름', '요약 주소');
  await input('받을 주소', 'https://push.example.net/hook');
  await click('등록', true);
  expect(document.body.textContent).toContain('이 세션을 찾지 못했거나 열 수 없습니다.');
  expect(document.body.textContent).not.toContain('raw server detail');
});

it('filters deliveries and maps every redeliver outcome', async () => {
  await render();
  await clickRow('요약 주소');
  expect(document.body.textContent).toContain('소식 보내기');
  expect(document.body.textContent).toContain('https://push.example.net/hooks/one');
  await click('실패');
  expect(calls('/api/webhooks/outbound/outbound-one/deliveries').some(([input]) => String(input).includes('state=dead'))).toBe(true);
  expect(document.body.textContent).not.toContain('전달됨');
  redeliverOutcome = 'delivered';
  deliveries = deliveries.map(item => item.id === 'delivery-one' ? { ...item, state: 'delivered' as const, last_status: 200 } : item);
  await act(async () => button('다시 보내기', true).click());
  expect([...document.querySelectorAll('[role="dialog"][data-open] button')].some(el => el.textContent?.trim() === '다시 보내기')).toBe(false);
  await click('전체');
  expect(document.body.textContent).toContain('전달됨');
  deliveries = deliveries.map(item => item.id === 'delivery-one' ? { ...item, state: 'dead' as const } : item);
  redeliverOutcome = 'dead';
  await click('실패');
  await act(async () => button('다시 보내기', true).click());
  expect(document.body.textContent).toContain('다시 보냈지만 실패했습니다.');
  redeliverOutcome = 'skipped';
  await act(async () => button('다시 보내기', true).click());
  expect(document.body.textContent).toContain('지금은 다시 보내지 못했습니다. 다시 시도하세요.');
  await click('전체');
  redeliverOutcome = 'retrying';
  deliveries = deliveries.map(item => item.id === 'delivery-one' ? { ...item, state: 'pending' as const } : item);
  await act(async () => button('다시 보내기', true).click());
  expect(document.body.textContent).toContain('다음 시도');
  expect(document.body.textContent).toContain('대기');
  expect(calls('/api/webhooks/outbound/outbound-one/deliveries').length).toBeGreaterThan(3);
});

it('handles 409 redeliver by reloading both lists', async () => {
  redeliverStatus = 409;
  await render();
  await clickRow('요약 주소');
  await click('실패');
  await act(async () => button('다시 보내기', true).click());
  expect(document.body.textContent).toContain('꺼진 상태에서는 다시 보낼 수 없습니다.');
  expect(calls('/api/webhooks/outbound').length).toBe(2);
  expect([...document.querySelectorAll('[role="dialog"][data-open] button')].some(el => el.textContent?.trim() === '다시 보내기')).toBe(false);
});

it('hides redeliver on a disabled subscription and explains why', async () => {
  await render();
  await clickRow('꺼진 수집기');
  expect(document.body.textContent).toContain('연속으로 20번 실패해 꺼졌습니다.');
  expect(document.body.textContent).toContain('다시 켜면 꺼져 있던 동안의 소식은 보내지 않습니다.');
  expect(document.querySelector('[role="dialog"][data-open] [aria-label="다시 보내기"]')).toBeNull();
});

it('patches the switch immediately and reverts on failure', async () => {
  await render();
  await clickRow('요약 주소');
  const toggle = document.querySelector<HTMLElement>('[role="dialog"][data-open] [role="switch"][aria-label="소식 보내기"]')!;
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  patchStatus = 503;
  await act(async () => toggle.click());
  expect(document.body.textContent).toContain('지금은 바꾸지 못했습니다. 다시 시도하세요.');
  expect(document.querySelector('[role="dialog"][data-open] [role="switch"][aria-label="소식 보내기"]')!.getAttribute('aria-checked')).toBe('true');
  expect(document.body.textContent).not.toContain('raw server detail');
  patchStatus = 200;
  await act(async () => document.querySelector<HTMLElement>('[role="dialog"][data-open] [role="switch"][aria-label="소식 보내기"]')!.click());
  expect(JSON.parse(String(calls('/api/webhooks/outbound/outbound-one', 'PATCH')[0]![1]?.body))).toEqual({ active: false });
  expect(document.querySelector('[role="dialog"][data-open] [role="switch"][aria-label="소식 보내기"]')!.getAttribute('aria-checked')).toBe('false');
  expect(calls('/api/webhooks/outbound').length).toBe(2);
});

it('deletes from the same dialog with a confirm step and re-reads the list', async () => {
  await render();
  await clickRow('요약 주소');
  await click('삭제', true);
  expect(document.body.textContent).toContain('나가는 웹훅 삭제');
  await click('삭제', true);
  expect(calls('/api/webhooks/outbound/outbound-one', 'DELETE')).toHaveLength(1);
  expect(calls('/api/webhooks/outbound')).toHaveLength(2);
  expect(document.body.textContent).not.toContain('요약 주소');
});

it('shows the delivery empty states per filter', async () => {
  deliveries = [];
  await render();
  await clickRow('요약 주소');
  expect(document.body.textContent).toContain('아직 보낸 소식이 없습니다.');
  await click('실패');
  expect(document.body.textContent).toContain('실패한 전달이 없습니다.');
  await click('대기');
  expect(document.body.textContent).toContain('기다리는 전달이 없습니다.');
});

/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccessLinksTab } from './AccessLinksTab';
import type { AccessLink } from '../lib/access-links-api';

vi.mock('./CatalogSelectionField', () => ({ CatalogSelectionField: ({ label, ariaLabel, value, options, disabled, invalid, message, onValueChange }: any) => <label>{label}<select aria-label={ariaLabel} aria-invalid={invalid || undefined} value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}><option value="">고르기</option>{options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{message}</label> }));

const sessionId = '12345678-1234-4234-8234-123456789abc';
const otherId = '87654321-1234-4234-8234-123456789abc';
const makeLink = (overrides: Partial<AccessLink> = {}): AccessLink => ({ id: 'one', label: '도우미', target_session_id: sessionId, permissions: ['send', 'read_own'], created_at: '2026-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', revoked_at: null, last_used_at: null, ...overrides });
let links: AccessLink[];
let sessionFail = false;
let issueStatus = 201;
let revokeStatus = 200;
let listFail = false;
let pendingIssue: ((response: Response) => void) | null = null;
let root: Root;
const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input);
  if (path === '/api/persistent-sessions') return sessionFail ? Response.json({}, { status: 503 }) : Response.json({ sessions: [{ session_id: sessionId, display_name: '✨ 영구 세션', agent_name: '로젤린' }] });
  if (init?.method === 'POST') {
    if (pendingIssue) return new Promise<Response>(resolve => { pendingIssue = resolve; });
    return issueStatus === 201 ? Response.json({ ...makeLink(), url: 'https://example.test/x/fake-key' }, { status: 201 }) : Response.json({ detail: 'raw server detail' }, { status: issueStatus });
  }
  if (init?.method === 'DELETE') {
    if (revokeStatus !== 200) return Response.json({ detail: 'raw server detail' }, { status: revokeStatus });
    links = links.map(link => ({ ...link, revoked_at: new Date().toISOString() }));
    return Response.json(links[0]);
  }
  return listFail ? Response.json({ detail: 'raw server detail' }, { status: 503 }) : Response.json(links);
});
beforeEach(() => {
  links = [makeLink(), makeLink({ id: 'past', label: '지난 이름', target_session_id: otherId, expires_at: '2020-01-01T00:00:00Z' })];
  sessionFail = false; issueStatus = 201; revokeStatus = 200; listFail = false; pendingIssue = null; request.mockClear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('CSS', { supports: () => false }); vi.stubGlobal('PointerEvent', MouseEvent);
  Element.prototype.scrollIntoView = vi.fn();
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(<AccessLinksTab request={request}/>)); }
function button(label: string, dialog = false) {
  const scope = dialog ? document.querySelector('[role="dialog"][data-open]')! : document.body;
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent?.trim() === label && !el.closest('[data-ending-style]'));
  expect(found, label).toBeTruthy(); return found!;
}
async function click(label: string, dialog = false) { await act(async () => button(label, dialog).click()); }
async function input(label: string, value: string, blur = false) {
  const el = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); if (blur) el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
}
async function chooseManual() {
  const select = document.querySelector<HTMLSelectElement>('[aria-label="대상 세션"]')!;
  await act(async () => { select.value = 'manual'; select.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function openForm() { await click('링크 만들기'); await chooseManual(); await input('세션 ID', sessionId); await input('발신자 이름', '  연결 이름  '); }

it('shows active and past links, PAS names and fallback IDs', async () => {
  await render(); expect(document.body.textContent).toContain('✨ 영구 세션');
  const details = document.querySelector('details')!; expect(details.open).toBe(false);
  expect(details.textContent).toContain('지난 이름'); expect(details.textContent).toContain('세션 87654321');
  sessionFail = true; await act(async () => root.unmount()); root = createRoot(document.body.appendChild(document.createElement('div'))); await render();
  expect(document.body.textContent).toContain('세션 12345678');
});
it('retries a list failure and offers manual entry when PAS loading fails', async () => {
  listFail = true; sessionFail = true; await render();
  expect(document.body.textContent).toContain('링크 목록을 불러오지 못했습니다.');
  expect(document.body.textContent).not.toContain('raw server detail');
  listFail = false; await click('다시 시도');
  expect(document.body.textContent).toContain('세션 12345678');
  await click('링크 만들기');
  expect(document.body.textContent).toContain('영구 세션 목록을 불러오지 못했습니다.');
  await chooseManual(); expect(document.querySelector('input[aria-label="세션 ID"]')).not.toBeNull();
});
it('issues with defaults, shows the address once and clears it on close', async () => {
  await render(); await openForm(); await click('링크 만들기', true);
  expect(JSON.parse(String(request.mock.calls.find(([, init]) => init?.method === 'POST')![1]?.body))).toEqual({ target_session_id: sessionId, label: '연결 이름', permissions: ['send', 'read_own'], expires_in_seconds: 86400 });
  expect(document.body.textContent).toContain('https://example.test/x/fake-key');
  await click('닫기', true); expect(document.body.textContent).not.toContain('fake-key');
});
it.each([[401, '로그인이 끝났습니다. 다시 로그인하세요.'], [404, '이 세션을 찾지 못했거나 열 수 없습니다.'], [422, '입력을 다시 확인하세요.'], [503, '지금은 링크를 만들 수 없습니다. 잠시 뒤 다시 시도하세요.']])('shows the mapped error for %s', async (status, text) => {
  issueStatus = status; await render(); await openForm(); await click('링크 만들기', true);
  expect(document.body.textContent).toContain(text); expect(document.body.textContent).not.toContain('raw server detail');
});
it('shows manual 404 after the ID and marks only that input invalid', async () => {
  issueStatus = 404; await render(); await openForm(); await click('링크 만들기', true);
  const id = document.querySelector('[aria-label="세션 ID"]')!;
  const select = document.querySelector('[aria-label="대상 세션"]')!;
  const error = [...document.querySelectorAll('[role="alert"]')].find(el => el.textContent?.includes('이 세션을 찾지'))!;
  expect(id.getAttribute('aria-invalid')).toBe('true');
  expect(select.getAttribute('aria-invalid')).toBeNull();
  expect(id.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it('marks the session selector invalid when a selected PAS returns 404', async () => {
  issueStatus = 404; await render(); await click('링크 만들기');
  const select = document.querySelector<HTMLSelectElement>('[aria-label="대상 세션"]')!;
  await act(async () => { select.value = sessionId; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await input('발신자 이름', '도우미'); await click('링크 만들기', true);
  expect(select.getAttribute('aria-invalid')).toBe('true');
  expect(document.body.textContent).toContain('이 세션을 찾지 못했거나 열 수 없습니다.');
});
it('returns the copy button to its initial state after a copy failure', async () => {
  const copy = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('failed'));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  await render(); await openForm(); await click('링크 만들기', true); await click('복사', true);
  expect(button('복사됨', true)).toBeTruthy(); await click('복사됨', true);
  expect(button('복사', true)).toBeTruthy();
  expect(document.body.textContent).toContain('복사하지 못했습니다.');
});
it('validates the manual ID and requires a permission', async () => {
  await render(); await openForm(); await input('세션 ID', 'bad', true);
  expect(document.body.textContent).toContain('세션 ID 형식이 아닙니다.');
  const boxes = [...document.querySelectorAll<HTMLElement>('[role="checkbox"]')];
  await act(async () => { boxes[0]!.click(); boxes[1]!.click(); });
  expect(document.body.textContent).toContain('하나 이상 고르세요.'); expect(button('링크 만들기', true).disabled).toBe(true);
});
it('prevents duplicate submissions and discards a late response after unmount', async () => {
  await render(); await openForm(); pendingIssue = () => {};
  await act(async () => { const submit = button('링크 만들기', true); submit.click(); submit.click(); });
  expect(button('만드는 중…', true).disabled).toBe(false);
  expect(button('만드는 중…', true).getAttribute('aria-disabled')).toBe('true');
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  const resolve = pendingIssue!; await act(async () => root.unmount()); root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => resolve(Response.json({ url: 'https://example.test/x/fake-late' }, { status: 201 })));
  expect(document.body.textContent).not.toContain('fake-late');
});
it.each([200, 404])('re-reads after revoke %s', async status => {
  revokeStatus = status; await render(); await click('폐기'); expect(document.body.textContent).toContain('이미 받은 요청의 작업은 이어집니다.');
  await click('폐기', true); expect(request.mock.calls.filter(([path]) => path === '/api/access-links')).toHaveLength(2);
  if (status === 200) expect(document.querySelector('details')?.textContent).toContain('도우미');
  expect(document.body.textContent).not.toContain('raw server detail');
});

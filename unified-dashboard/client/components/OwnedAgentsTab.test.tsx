/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OwnedAgentsTab } from './OwnedAgentsTab';
import type { OwnedAgent, OwnedAgentKey } from '../lib/owned-agents-api';

let root: Root;
const key: OwnedAgentKey = { id: 'k1', createdAt: '2026-10-04T00:00:00Z', lastUsedAt: null, revokedAt: null, isExistingConnection: true };
const agent: OwnedAgent = { id: 'a1', name: '내 도우미', enabled: true, ownerEmail: 'hidden@example.test', createdAt: key.createdAt, updatedAt: key.createdAt, keys: [key] };
let agents: typeof agent[];
let registered: boolean;
let fail: boolean;
const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
  if (fail) { fail = false; return Response.json({ detail: '잠시 후 다시 시도하세요' }, { status: 503 }); }
  if (String(url).endsWith('register-existing')) { registered = true; agents = [agent]; return Response.json({ agent, credential: key }); }
  if (init?.method === 'DELETE') { agents[0] = { ...agents[0], keys: [{ ...key, revokedAt: key.createdAt }] }; return new Response(null, { status: 204 }); }
  if (String(url).endsWith('/keys')) return Response.json({ credential: key, token: 'fake-once-token' });
  if (init?.method === 'POST') { agents.push({ ...agent, id: 'a2', ...JSON.parse(init.body as string), keys: [] }); return Response.json({ agent: agents.at(-1) }); }
  if (init?.method === 'PATCH') { agents[0] = { ...agents[0], ...JSON.parse(init.body as string) }; return Response.json({ agent: agents[0] }); }
  return Response.json({ agents, existingConnection: { configured: true, registered, canRegister: !registered } });
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('CSS', { supports: () => false });
  vi.stubGlobal('PointerEvent', MouseEvent);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  agents = []; registered = false; fail = false; request.mockClear();
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
async function render(node: ReactNode = <OwnedAgentsTab request={request} />) { await act(async () => root.render(node)); }
function button(label: string) { const el = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => !b.closest('[data-ending-style]') && (b.textContent?.trim() === label || b.getAttribute('aria-label') === label)); expect(el).toBeTruthy(); return el!; }
async function click(label: string) { await act(async () => button(label).click()); }
async function input(value: string) { const el = document.querySelector<HTMLInputElement>('[role="dialog"][data-open] input')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); }); }

it('registers the existing connection, copies a one-time key, clears it on close and revokes', async () => {
  await render(); expect(document.body.textContent).toContain('아직 등록한 에이전트가 없습니다');
  await click('기존 연결 등록'); expect(document.body.textContent).toContain('내 도우미');
  expect(document.body.textContent).not.toContain(agent.ownerEmail);
  await click('새 키 발급'); expect(document.body.textContent).toContain('fake-once-token');
  await click('복사'); expect(navigator.clipboard.writeText).toHaveBeenCalledWith('fake-once-token');
  await click('닫기'); expect(document.body.textContent).not.toContain('fake-once-token');
  await click('키 폐기'); await click('폐기'); expect(document.body.textContent).toContain('폐기됨');
  for (const [, init] of request.mock.calls) expect(init?.body ?? '').not.toMatch(/owner|caller|token/);
});

it('preserves a name after failure and supports create, rename and activation', async () => {
  await render(); await click('에이전트 추가'); await input('새 도우미'); fail = true;
  await click('저장'); expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('새 도우미');
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  await click('저장'); expect(document.body.textContent).toContain('새 도우미');
  await click('이름 변경'); await input('바뀐 도우미'); await click('저장');
  expect(document.body.textContent).toContain('바뀐 도우미');
  await act(async () => (document.querySelector('[role="switch"]') as HTMLButtonElement).click());
  expect(agents[0].enabled).toBe(false);
});

it('retries list failure and explains unavailable registration', async () => {
  fail = true; await render(); await click('다시 시도');
  registered = true; await render(null); await render();
  expect(document.body.textContent).toContain('기존 연결이 등록되어 있습니다');
  expect([...document.querySelectorAll('button')].some(b => b.textContent === '기존 연결 등록')).toBe(false);
});

it('guards double issuance and drops a pending key when the panel closes', async () => {
  agents = [agent]; registered = true;
  await render();
  let resolve!: (value: Response) => void;
  request.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }));
  await act(async () => { button('새 키 발급').click(); button('새 키 발급').click(); });
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  await render(null);
  await act(async () => resolve(Response.json({ credential: key, token: 'late-fake-key' })));
  await render(); expect(document.body.textContent).not.toContain('late-fake-key');
});

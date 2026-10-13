import { afterEach, expect, it, vi } from 'vitest';
import { toSessionSummary } from './mappers';
import { buildSessionUpdates } from '../hooks/session-stream-helpers';
import { useDashboardStore } from '../stores/dashboard-store';
import { submitIntervention } from '../components/chat/submitIntervention';

afterEach(() => { useDashboardStore.getState().reset(); vi.unstubAllGlobals(); });
const report = [{ key: 'one', kind: 'ask' as const, title: '확인', card_numbers: [270], context: '맥락', action: '진행할까?', options: ['응'], state: 'open' as const, answer: '', updated_at: '2026-10-13T00:00:00Z' }];
it('maps both REST report spellings and preserves omission versus an empty board', () => {
  expect(toSessionSummary({ agent_session_id: 'a', persistent_report: report }).persistentReport).toEqual(report);
  expect(toSessionSummary({ agentSessionId: 'a', persistentReport: [] }).persistentReport).toEqual([]);
  expect(toSessionSummary({ agentSessionId: 'a' })).not.toHaveProperty('persistentReport');
});
it('projects a full SSE board, explicit clearing, and omitted report fields', () => {
  expect(buildSessionUpdates({ type: 'session_updated', agent_session_id: 'a', persistent_report: report }).persistentReport).toEqual(report);
  expect(buildSessionUpdates({ type: 'session_updated', agent_session_id: 'a', persistent_report: [] }).persistentReport).toEqual([]);
  expect(buildSessionUpdates({ type: 'session_updated', agent_session_id: 'a' })).not.toHaveProperty('persistentReport');
});
it('keeps an SSE board when a GET started earlier completes later, including a cleared board', () => {
  const store = useDashboardStore.getState();
  const baseline = store.persistentReports.a;
  store.setPersistentReport('a', report);
  store.setPersistentReport('a', [], { current: baseline });
  expect(useDashboardStore.getState().persistentReports.a).toBe(report);
  store.setPersistentReport('a', []);
  store.setPersistentReport('a', report, { current: report });
  expect(useDashboardStore.getState().persistentReports.a).toEqual([]);
});
it('transports report reply context on the authenticated intervention path', async () => {
  const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ delivered: true }) });
  vi.stubGlobal('fetch', request);
  const contextItems = [{ key: 'persistent_report_reply', content: { key: 'one', option: '응' } }];
  await submitIntervention({ sessionKey: 'a', text: '확인: 응', contextItems });
  expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ context_items: contextItems });
  expect(request.mock.calls[0][1].credentials).toBe('include');
});

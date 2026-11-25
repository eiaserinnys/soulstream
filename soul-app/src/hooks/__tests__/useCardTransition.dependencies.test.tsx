import { act, renderHook } from '@testing-library/react-native';
import { Alert } from 'react-native';
import type { CardDependency } from '../../../../packages/wire-schema/src/card_dependency_display';
import type { CardDto } from '../../api/cardTypes';
import { cardFixture } from '../../test-support/cards';
import { useCardTransition } from '../useCardTransition';

const dep = (overrides: Partial<CardDependency> = {}): CardDependency => ({
  id: 'dep', number: 1864, title: '선행', status: 'running', archived: false, met: false, ...overrides });
const unmet = [
  dep({ id: 'a', number: 1864, status: 'running' }),
  dep({ id: 'b', number: 1861, status: 'cancelled' }),
  dep({ id: 'c', number: 1860, status: 'queued', archived: true }),
  dep({ id: 'd', number: 1863, status: 'done', met: true }),
];
// 카드 쓰기 상태는 모듈 전역이라 시험마다 다른 카드 id를 쓴다.
let sequence = 0;
const fresh = (overrides: Partial<CardDto> = {}) => cardFixture({ id: `dep-card-${++sequence}`, status: 'queued', assigneeSessionId: 'owner', dependsOn: unmet, ...overrides });
function setup(card = fresh()) {
  const started = { ...card, status: 'running' as const };
  const api = {
    getCard: jest.fn().mockResolvedValue({ card, reports: [], questions: [], sessions: [] }),
    executeCard: jest.fn().mockResolvedValue({ card: started, execution: { requestId: 'r', sessionId: 'owner', state: 'started' } }),
    setCardStatus: jest.fn().mockResolvedValue({ card: { ...card, status: 'done' } }),
    saveCardExecutionSettings: jest.fn(),
  };
  return { card, api, hook: renderHook(() => useCardTransition(api as any, card.id)) };
}
const answer = (alert: jest.SpyInstance, text: string) => {
  const buttons = alert.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
  buttons.find(button => button.text === text)!.onPress!();
};

let alert: jest.SpyInstance;
beforeEach(() => { alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {}); });
afterEach(() => alert.mockRestore());

test('미충족 선행이 있으면 웹과 같은 문구와 단추로 한 번 묻는다', async () => {
  const { card, api, hook } = setup();
  let result!: Promise<boolean>;
  await act(async () => { result = hook.result.current.transition(card, 'running'); await Promise.resolve(); await Promise.resolve(); });
  expect(alert).toHaveBeenCalledTimes(1);
  const [title, message, buttons] = alert.mock.calls[0];
  expect(title).toBe('선행 카드가 끝나지 않았습니다');
  expect(message).toBe('#1864(실행 중), #1861(취소), #1860(보관됨)이 아직 충족되지 않았습니다. 기다리지 않고 지금 시작할까요?');
  expect(buttons.map((button: any) => [button.text, button.style])).toEqual([['취소', 'cancel'], ['지금 시작', undefined]]);
  expect(api.executeCard).not.toHaveBeenCalled();
  await act(async () => { answer(alert, '취소'); expect(await result).toBe(false); });
  expect(api.executeCard).not.toHaveBeenCalled();
  expect(hook.result.current.error).toBeNull();
  expect(alert).toHaveBeenCalledTimes(1); // 실패 안내 같은 두 번째 Alert 없음
});

test('지금 시작을 고르면 기존 실행 경로로 요청을 보낸다', async () => {
  const { card, api, hook } = setup();
  let result!: Promise<boolean>;
  await act(async () => { result = hook.result.current.transition(card, 'running'); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { answer(alert, '지금 시작'); expect(await result).toBe(true); });
  expect(api.executeCard).toHaveBeenCalledTimes(1);
});

test('확인에는 서버에서 막 읽은 카드의 선행을 쓴다', async () => {
  const stale = fresh({ dependsOn: [dep({ status: 'done', met: true })] });
  const latest = { ...stale, dependsOn: [dep({ number: 7, status: 'running' })] };
  const { api, hook } = setup(latest);
  await act(async () => { void hook.result.current.transition(stale, 'running'); await Promise.resolve(); await Promise.resolve(); });
  expect(alert.mock.calls[0][1]).toBe('#7(실행 중)이 아직 충족되지 않았습니다. 기다리지 않고 지금 시작할까요?');
  expect(api.executeCard).not.toHaveBeenCalled();
  await act(async () => { answer(alert, '취소'); await Promise.resolve(); });
});

test.each([[undefined], [[]], [[dep({ status: 'done', met: true })]]])('선행이 없거나 모두 충족되면 묻지 않는다 (%j)', async dependsOn => {
  const { card, api, hook } = setup(fresh({ dependsOn: dependsOn as any }));
  await act(async () => { expect(await hook.result.current.transition(card, 'running')).toBe(true); });
  expect(alert).not.toHaveBeenCalled();
  expect(api.executeCard).toHaveBeenCalledTimes(1);
});

test('running이 아닌 전환은 선행이 있어도 묻지 않는다', async () => {
  const { card, api, hook } = setup(fresh({ status: 'review' }));
  await act(async () => { expect(await hook.result.current.transition(card, 'done')).toBe(true); });
  expect(alert).not.toHaveBeenCalled();
  expect(api.setCardStatus).toHaveBeenCalledTimes(1);
});

test('실행 설정을 입력받는 길은 시작 확인 뒤에만 열리고 저장 뒤 다시 묻지 않는다', async () => {
  const card = fresh({ assigneeSessionId: null, nodeId: null, modelPreset: null });
  const value = { folderId: card.folderId, nodeId: 'node-1', agentId: 'roselin', modelPreset: 'sol' };
  const saved = { ...card, nodeId: 'node-1', modelPreset: 'sol', version: 2 };
  const { api, hook } = setup(card);
  api.saveCardExecutionSettings.mockImplementation(async () => { api.getCard.mockResolvedValue({ card: saved, reports: [], questions: [], sessions: [] }); return { card: saved }; });
  await act(async () => { void hook.result.current.transition(card, 'running'); await Promise.resolve(); await Promise.resolve(); });
  expect(alert).toHaveBeenCalledTimes(1);
  await act(async () => { answer(alert, '지금 시작'); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(hook.result.current.settingsCard).toEqual(card);
  await act(async () => { await hook.result.current.saveSettingsAndExecute(value); });
  expect(api.executeCard).toHaveBeenCalledTimes(1);
  expect(alert).toHaveBeenCalledTimes(1);
});

test('시작 확인을 취소하면 설정 입력 길도 열지 않는다', async () => {
  const card = fresh({ assigneeSessionId: null, nodeId: null, modelPreset: null });
  const { api, hook } = setup(card);
  let result!: Promise<boolean>;
  await act(async () => { result = hook.result.current.transition(card, 'running'); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { answer(alert, '취소'); expect(await result).toBe(false); });
  expect(hook.result.current.settingsCard).toBeNull();
  expect(api.executeCard).not.toHaveBeenCalled();
});

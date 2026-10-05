import { act, fireEvent, render } from '@testing-library/react-native';
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import type { CardCheckItem } from '../../../api/cardTypes';
import { summarizeCardItems } from '../../../lib/card-check-item-summary';
import { CardCheckItems } from '../CardCheckItems';

function item(id: number, display: CardCheckItem['display'], overrides: Partial<CardCheckItem> = {}): CardCheckItem {
  const state = display === 'doing' ? 'doing' : display === 'dropped' ? 'dropped' : display === 'reported' || display === 'changed' ? 'done' : 'todo';
  return { id, title: `항목 ${id}`, state, result: display === 'dropped' ? '범위에서 뺀 이유' : '확인할 결과',
    evidence: [], caveat: null, rev: 1, confirmed: display === 'confirmed' ? { at: '', rev: 1 } : null,
    fixOpen: display === 'fix' ? 2 : 0, reopened: display === 'changed' ? '다시 확인한 이유' : null,
    from: null, createdAt: '', reportedAt: null, display, ...overrides };
}

test('서버 display 일곱 값을 그대로 표시하고 확인·고칠 점 조작을 항목에 연결한다', async () => {
  const onConfirm = jest.fn().mockResolvedValue(true);
  const onSetTarget = jest.fn();
  const onRecentConfirmation = jest.fn();
  const screen = render(<CardCheckItems items={[
    item(1, 'todo'), item(2, 'doing'), item(3, 'reported'), item(4, 'changed'),
    item(5, 'fix'), item(6, 'confirmed'), item(7, 'dropped'),
  ]} pendingConfirmations={{}} initiallyConfirmedIds={[6]} newlyConfirmedIds={[]}
    onConfirm={onConfirm} onSetTarget={onSetTarget} onRecentConfirmation={onRecentConfirmation} paneWidth={375} />);
  await act(async () => {});

  for (const label of ['아직', '하는 중', '됐다고 보고', '다시 봐 주세요', '고칠 점 2', '확인함', '뺌']) {
    expect(screen.getByText(label)).toBeTruthy();
  }
  const runningDot = screen.getByTestId('card-check-item-2-status').children[0] as any;
  expect(runningDot.props.style).toMatchObject({ width: 8, height: 8 });
  expect(screen.getByText('범위에서 뺀 이유')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('1 항목 1 확인'));
  expect(onConfirm).toHaveBeenCalledWith(1, true);
  fireEvent.press(screen.getByLabelText('4 항목 4 고칠 점 남기기'));
  expect(onSetTarget).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }));
});

test('확인 항목의 상태 기호와 근거 기호는 Ionicons로 렌더링한다', () => {
  const screen = render(<CardCheckItems items={[
    item(1, 'reported', { caveat: '기기에서 다시 봐 주세요.', evidence: [{ type: 'link', url: 'https://example.test', label: '근거 링크' }] }),
    item(2, 'confirmed'),
  ]} pendingConfirmations={{}} initiallyConfirmedIds={[2]} newlyConfirmedIds={[]}
    onConfirm={jest.fn()} onSetTarget={jest.fn()} onRecentConfirmation={jest.fn()} paneWidth={375} />);

  expect(screen.getByTestId('card-check-item-1-caveat-icon').props.name).toBe('warning-outline');
  expect(screen.getByTestId('card-check-item-1-link-icon').props.name).toBe('open-outline');
  expect(screen.getByTestId('card-item-checkbox-2-checkmark').props.name).toBe('checkmark');
});

test('진입 시 확인된 셋은 묶고 확인 해제하면 미확인 목록으로 돌린다', () => {
  const props = { items: [item(1, 'confirmed'), item(2, 'confirmed'), item(3, 'confirmed'), item(4, 'todo')],
    pendingConfirmations: {}, initiallyConfirmedIds: [1, 2, 3], newlyConfirmedIds: [],
    onConfirm: jest.fn().mockResolvedValue(true), onSetTarget: jest.fn(), onRecentConfirmation: jest.fn(), paneWidth: 375 };
  const screen = render(<CardCheckItems {...props} />);

  fireEvent.press(screen.getByLabelText('확인함 3개 펼치기'));
  fireEvent.press(screen.getByLabelText('1 항목 1 확인 해제'));
  expect(props.onConfirm).toHaveBeenCalledWith(1, false);
  expect(props.onSetTarget).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  screen.rerender(<CardCheckItems {...props} pendingConfirmations={{ 1: { confirmed: false, requestId: 'unconfirm' } }} />);
  expect(screen.queryByText('확인함 2개')).toBeNull();
  expect(screen.getByText('항목 1')).toBeTruthy();
  expect(screen.getByText('항목 2')).toBeTruthy();
  expect(screen.getByText('항목 3')).toBeTruthy();
});

test('서버가 확인을 풀면 방금 확인한 기록이 있어도 체크가 풀린다', async () => {
  const onConfirm = jest.fn().mockResolvedValue(true);
  const onSetTarget = jest.fn();
  const props = { items: [item(1, 'todo')], pendingConfirmations: {}, initiallyConfirmedIds: [],
    newlyConfirmedIds: [], onConfirm, onSetTarget, onRecentConfirmation: jest.fn(), paneWidth: 375 };
  const screen = render(<CardCheckItems {...props} />);
  fireEvent.press(screen.getByLabelText('1 항목 1 확인'));
  screen.rerender(<CardCheckItems {...props}
    pendingConfirmations={{ 1: { confirmed: true, requestId: 'confirm' } }} newlyConfirmedIds={[1]} />);
  await act(async () => {});
  expect(screen.getByTestId('card-item-checkbox-1').props.accessibilityState.checked).toBe(true);

  screen.rerender(<CardCheckItems {...props} items={[item(1, 'fix')]} newlyConfirmedIds={[1]} />);
  expect(screen.getByTestId('card-item-checkbox-1').props.accessibilityState.checked).toBe(false);

  const pendingSummary = summarizeCardItems([item(2, 'reported'), item(3, 'confirmed')], {
    2: { confirmed: true, requestId: 'confirm-reported' },
    3: { confirmed: false, requestId: 'unconfirm-confirmed' },
  });
  expect(pendingSummary.confirmed).toBe(1);
  expect(pendingSummary.unconfirmed.map((entry) => entry.id)).toEqual([3]);
  expect(pendingSummary.needsReview).toBe(0);
});

test('접힌 확인 항목이 서버에서 뺌으로 바뀌면 뺀 까닭을 펼쳐 보인다', () => {
  const onRecentConfirmation = jest.fn();
  const props = { pendingConfirmations: {}, initiallyConfirmedIds: [1], newlyConfirmedIds: [],
    onConfirm: jest.fn().mockResolvedValue(true), onSetTarget: jest.fn(), onRecentConfirmation, paneWidth: 375 };
  const screen = render(<CardCheckItems {...props} items={[item(1, 'confirmed')]} />);
  expect(screen.queryByText('범위에서 뺀 이유')).toBeNull();

  screen.rerender(<CardCheckItems {...props} items={[item(1, 'dropped', { result: '서버가 기록한 제외 이유' })]} />);
  expect(screen.getByText('서버가 기록한 제외 이유')).toBeTruthy();
});

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../menus/AppContextMenu', () => ({ showAppContextMenu: jest.fn() }));
import { createRef } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import type { CardDependency } from '../../../../../packages/wire-schema/src/card_dependency_display';
import { cardFixture } from '../../../test-support/cards';
import { POST_IT_COLORS } from '../../../theme/postItRoles';
import { withAlphaColor } from '../../StatusPulseDecoration';
import { PostItCard, type PostItCardHandle } from '../PostItCard';
import { showAppContextMenu } from '../../menus/AppContextMenu';

const dep = (overrides: Partial<CardDependency> = {}): CardDependency => ({
  id: 'dep-1', number: 12, title: '선행 카드', status: 'running', archived: false, met: false, ...overrides,
});
const now = { text: '지금 진행', turn: 'user' as const, ask: '이것을 확인해 주세요', updatedAt: '', sessionId: 's' };
const band = (screen: ReturnType<typeof render>) => screen.queryByTestId('postit-card-1-dependency');

test.each(['full', 'compact'] as const)('queued 카드는 선행 대기 문구를 띠에 보이고 볼 것과 ask를 대신한다 (%s)', variant => {
  const card = cardFixture({ status: 'queued', now, dependsOn: [dep()],
    items: [{ id: 1, title: '확인', display: 'reported' }] as any });
  const screen = render(<PostItCard api={null} card={card} variant={variant} onOpen={() => {}} />);
  expect(band(screen)!.props.children).toBe('선행 대기 #12');
  expect(screen.queryByTestId('postit-card-1-ask-preview')).toBeNull();
  expect(screen.queryByText(/이것을 확인해 주세요/)).toBeNull();
  // 요청 본문 자리는 덮지 않는다.
  expect(screen.getByTestId('postit-body-card-1')).toBeTruthy();
});

test('중립 띠는 경고 배경 없이 포스트잇 보조 글자색을 쓰고 오류 띠는 오류 글자와 옅은 오류 배경을 쓴다', () => {
  const neutral = render(<PostItCard api={null} card={cardFixture({ status: 'queued', dependsOn: [dep()] })} onOpen={() => {}} />);
  const neutralStyle = band(neutral)!.props.style;
  expect(neutralStyle.color).toBe(POST_IT_COLORS.textSecondary);
  expect(neutralStyle.backgroundColor).toBeUndefined();
  // 배경 상자가 없는 중립 띠는 가로 여백이 없어 제목·본문과 같은 시작선이다.
  expect(neutralStyle.paddingHorizontal ?? 0).toBe(0);
  neutral.unmount();
  const error = render(<PostItCard api={null} card={cardFixture({ status: 'queued', dependsOn: [dep({ status: 'cancelled' })] })} onOpen={() => {}} />);
  const errorStyle = band(error)!.props.style;
  expect(band(error)!.props.children).toBe('선행 취소됨 #12');
  expect(errorStyle.color).toBe(POST_IT_COLORS.errorText);
  expect(errorStyle.backgroundColor).toBe(withAlphaColor(POST_IT_COLORS.error, 0.08));
  expect(errorStyle.paddingHorizontal).toBeGreaterThan(0);
});

test('여러 선행은 충족된 것을 빼고 두 장까지 번호를 적고 그 위는 외 N건으로 줄인다', () => {
  const screen = render(<PostItCard api={null} onOpen={() => {}} card={cardFixture({ status: 'queued', dependsOn: [
    dep({ id: 'a', number: 11, status: 'done', met: true }), dep({ id: 'b', number: 12 }), dep({ id: 'c', number: 13 }), dep({ id: 'd', number: 14 })] })} />);
  expect(band(screen)!.props.children).toBe('선행 대기 #12 외 2건');
});

test.each(['todo', 'on_hold', 'running'] as const)('%s 카드에는 선행이 있어도 띠를 띄우지 않고 볼 것 띠를 지킨다', status => {
  const card = cardFixture({ status, now, dependsOn: [dep()] });
  const screen = render(<PostItCard api={null} card={card} onOpen={() => {}} />);
  expect(band(screen)).toBeNull();
  expect(screen.getByTestId('postit-card-1-ask-preview')).toBeTruthy();
});

test('선행이 모두 충족됐거나 옛 서버 응답처럼 없으면 띠가 없고 볼 것 띠가 남는다', () => {
  for (const dependsOn of [undefined, [dep({ status: 'done', met: true })]]) {
    const screen = render(<PostItCard api={null} card={cardFixture({ status: 'queued', now, dependsOn })} onOpen={() => {}} />);
    expect(band(screen)).toBeNull();
    expect(screen.getByTestId('postit-card-1-ask-preview')).toBeTruthy();
    screen.unmount();
  }
});

test('띠가 있으면 본문 줄 수에서 띠 자리를 빼서 아래 띠가 잘리지 않는다', () => {
  const plain = cardFixture({ status: 'queued' });
  const waiting = cardFixture({ status: 'queued', dependsOn: [dep()] });
  const a = render(<PostItCard api={null} card={plain} onOpen={() => {}} />);
  const b = render(<PostItCard api={null} card={waiting} onOpen={() => {}} />);
  expect(b.getByTestId('postit-body-card-1').props.numberOfLines).toBeLessThan(a.getByTestId('postit-body-card-1').props.numberOfLines);
});

test('포스트잇 상태 메뉴에서 실행 중으로 옮길 때도 미충족 선행을 한 번 묻고 취소하면 요청하지 않는다', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const card = cardFixture({ id: 'menu-dep', status: 'queued', assigneeSessionId: 'owner', dependsOn: [dep({ number: 1864 })] });
  const api = { getCard: jest.fn().mockResolvedValue({ card, reports: [], questions: [], sessions: [] }), executeCard: jest.fn() };
  const screen = render(<PostItCard api={api as any} card={card} variant="compact" onOpen={() => {}} />);
  fireEvent.press(screen.getByLabelText('상태 변경'));
  await waitFor(() => expect(screen.getByLabelText(/^실행 중.*이동$/)).toBeTruthy());
  fireEvent.press(screen.getByLabelText(/^실행 중.*이동$/));
  await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
  expect(alert.mock.calls[0][1]).toBe('#1864(실행 중)이 아직 충족되지 않았습니다. 기다리지 않고 지금 시작할까요?');
  (alert.mock.calls[0][2] as any[]).find(button => button.text === '취소').onPress();
  await waitFor(() => expect(screen.queryByLabelText(/^실행 중.*이동$/)).toBeTruthy());
  expect(api.executeCard).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledTimes(1);
  // 취소는 실패가 아니라 오류 문구와 빈 결과 창을 띄우지 않는다.
  expect(screen.queryByRole('alert')).toBeNull();
  alert.mockRestore();
});

test('길게 누르기 메뉴에서 실행 중을 고르고 시작 확인을 취소하면 요청도 빈 메뉴 창도 남지 않는다', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const card = cardFixture({ id: 'ctx-dep', status: 'queued', assigneeSessionId: 'owner', dependsOn: [dep({ number: 1864 })] });
  const api = { getCard: jest.fn().mockResolvedValue({ card, reports: [], questions: [], sessions: [] }), executeCard: jest.fn() };
  const ref = createRef<PostItCardHandle>();
  const screen = render(<PostItCard ref={ref} api={api as any} card={card} variant="compact" onOpen={() => {}} />);
  const mocked = showAppContextMenu as jest.Mock;
  mocked.mockClear();
  act(() => ref.current!.openContextMenu());
  const actions = mocked.mock.calls[0][0] as Array<{ key: string; onSelect(): void }>;
  await act(async () => actions.find(action => action.key === 'status-running')!.onSelect());
  await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId('card-status-menu')).toBeNull();
  await act(async () => { (alert.mock.calls[0][2] as any[]).find(button => button.text === '취소').onPress(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(api.executeCard).not.toHaveBeenCalled();
  // 보이지 않게 떠 있던 CardStatusMenu가 결과 창으로 열리지 않고 메뉴째 사라진다.
  expect(screen.queryByTestId('card-status-menu')).toBeNull();
  expect(screen.queryByTestId('card-status-loading')).toBeNull();
  // 같은 상태를 다시 골라도 다시 묻는다(숨은 메뉴가 남아 다음 선택을 막지 않는다).
  await act(async () => actions.find(action => action.key === 'status-running')!.onSelect());
  await waitFor(() => expect(alert).toHaveBeenCalledTimes(2));
  alert.mockRestore();
});

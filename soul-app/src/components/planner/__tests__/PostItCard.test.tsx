jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { cardFixture } from '../../../test-support/cards';
import { PostItCard, postItRotation } from '../PostItCard';
import { postItActivityText } from '../../../lib/postit-activity';

test('같은 공통 포스트잇 full/compact는 비율·글자·조작최소를 유지하고 compact본문만2줄이다', () => {
  const card = cardFixture({ latestActivity: { kind: 'report', format: 'markdown', body: '보고 원문\n두 번째 줄\n세 번째 줄', createdAt: '' } });
  const screen = render(<PostItCard api={null} card={card} onOpen={() => {}} />);
  const full = screen.getByTestId('postit-card-card-1').props.style;
  const font = screen.getByTestId('postit-body-card-1').props.style.fontSize;
  screen.rerender(<PostItCard api={null} card={card} variant="compact" onOpen={() => {}} />);
  const compact = screen.getByTestId('postit-card-card-1').props.style;
  expect(full.width / full.height).toBeCloseTo(320 / 280);
  expect(compact.width).toBeCloseTo(full.width * 0.8);
  expect(compact.width / compact.height).toBeCloseTo(320 / 280);
  expect(compact.transform).toEqual([{ rotate: `${postItRotation(card.id)}deg` }]);
  expect(screen.getByTestId('postit-body-card-1').props.style.fontSize).toBe(font);
  expect(screen.getByTestId('postit-body-card-1').props.numberOfLines).toBe(2);
  expect(screen.getByText('마지막 보고').props.style.fontSize).toBeGreaterThanOrEqual(13);
});

test('포스트잇 mount는 상세를 읽지 않고 카드 탭은 기존 상세로 전달한다', () => {
  const getCard = jest.fn(); const onOpen = jest.fn();
  const screen = render(<PostItCard api={{ getCard } as any} card={cardFixture()} variant="compact" onOpen={onOpen} />);
  expect(getCard).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('카드 제목 카드 상세'));
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test('ID 기울기는 기존 웹과 같은5개이며 HTML보고는 실행하지 않고 본문 텍스트만 표시한다', () => {
  expect(['a', 'b', 'c', 'd', 'e'].map(postItRotation).sort()).toEqual([-0.8, -0.4, 0, 0.4, 0.8].sort());
  expect(postItActivityText({ body: '<style>숨김</style><script>실행</script><p>보고 &amp; 확인</p><p>두 번째</p>', format: 'html' })).toBe('보고 & 확인\n두 번째');
});

test('완료는 기존 version/opId 계약을 쓰고 실패하면 알리고 카드를 유지한다', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const api = { getCard: jest.fn(), setCardStatus: jest.fn().mockRejectedValue(new Error('변경 실패')) };
  const card = cardFixture({ status: 'review' });
  const screen = render(<PostItCard api={api as any} card={card} variant="compact" onOpen={() => {}} />);
  expect(api.getCard).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(screen.getByLabelText('완료')));
  expect(api.setCardStatus).toHaveBeenCalledWith(card.id, 'done', card.version, expect.stringMatching(/^soul-app-card-/));
  expect(alert).toHaveBeenCalledWith('카드 변경 실패', '변경 실패');
  expect(screen.getByText('검수 대기')).toBeTruthy();
  expect(api.getCard).not.toHaveBeenCalled();
  alert.mockRestore();
});

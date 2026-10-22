import { resolvePersistentConversationLeft } from '../persistent-session-column';

const base = {
  tasksWidth: 170,
  phone: false,
  cardsScene: true,
  pageInset: 20,
  gap: 12,
  cardPanelRightOffset: 12,
};

describe('PAS 대화 열 좌표', () => {
  test('아이폰 듀오 안쪽 세로는 카드 패널 왼쪽으로 밀린다', () => {
    expect(resolvePersistentConversationLeft({ ...base, appWidth: 669, columnWidth: 400 }))
      .toBe(75);
  });

  test('아이폰 듀오 안쪽 가로(레일 제외 867)도 카드 패널을 피한다', () => {
    expect(resolvePersistentConversationLeft({
      ...base,
      appWidth: 867,
      columnWidth: 480,
      tasksWidth: 240,
    })).toBe(123);
  });

  test('중앙 배치가 더 왼쪽이면 중앙을 유지한다', () => {
    expect(resolvePersistentConversationLeft({
      ...base,
      appWidth: 1008,
      columnWidth: 480,
      tasksWidth: 240,
    })).toBe(264);
    expect(resolvePersistentConversationLeft({
      ...base,
      appWidth: 1366,
      columnWidth: 480,
      tasksWidth: 240,
    })).toBe(443);
  });

  test('폰과 채팅 장면은 중앙 배치다', () => {
    expect(resolvePersistentConversationLeft({ ...base, appWidth: 669, columnWidth: 400, phone: true }))
      .toBe(134.5);
    expect(resolvePersistentConversationLeft({ ...base, appWidth: 669, columnWidth: 400, cardsScene: false }))
      .toBe(134.5);
  });
});

/**
 * PAS 대화 열의 왼쪽 좌표.
 *
 * 태블릿 카드 장면에서는 우측 카드 패널(tasks)과 겹치지 않도록 대화 열을 왼쪽으로
 * 밀되, 화면 중앙보다 오른쪽으로는 가지 않는다. 폰이나 채팅 장면은 항상 중앙이다.
 */
export function resolvePersistentConversationLeft({
  appWidth,
  columnWidth,
  tasksWidth,
  phone,
  cardsScene,
  pageInset,
  gap,
  cardPanelRightOffset,
}: {
  appWidth: number;
  columnWidth: number;
  tasksWidth: number;
  phone: boolean;
  cardsScene: boolean;
  pageInset: number;
  gap: number;
  cardPanelRightOffset: number;
}): number {
  const centered = (appWidth - columnWidth) / 2;
  if (phone || !cardsScene) return centered;
  const taskPanelLeft = appWidth - cardPanelRightOffset - tasksWidth;
  const shifted = Math.max(pageInset, taskPanelLeft - gap - columnWidth);
  return Math.min(centered, shifted);
}

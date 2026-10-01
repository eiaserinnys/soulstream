/**
 * 떠 있는 패널의 바깥 여백이 이미 소비한 만큼을 제외하고,
 * 패널 내부 조작부가 추가로 비켜야 할 하단 safe-area만 반환한다.
 */
export function resolveTabletBottomSafeAreaPadding(
  safeAreaBottom: number,
  outerInset: number,
): number {
  return Math.max(0, safeAreaBottom - outerInset);
}

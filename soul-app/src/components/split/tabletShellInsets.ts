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

/** 대화 칸이 입력 상자에 넘기는 최소 하단 여백. 카드 커멘트 상자도 같은 값을 쓴다. */
export function resolveChatPaneMinimumBottomPadding(
  panelMinimumBottomPadding: number | undefined,
  safeAreaBottom: number,
  outerInset: number,
): number {
  return panelMinimumBottomPadding ?? resolveTabletBottomSafeAreaPadding(safeAreaBottom, outerInset);
}

/** 입력 상자가 실제로 띄우는 바닥 간격. 대화 칸과 카드 커멘트 상자가 함께 쓴다. */
export function resolveChatComposerBottomGap(
  minimumBottomPadding: number,
  minimumGap: number,
): number {
  return Math.max(minimumGap, minimumBottomPadding);
}

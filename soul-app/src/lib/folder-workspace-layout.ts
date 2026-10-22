// 기존 카드 상세 sheet와 PAS 상세가 같은 폭과 배경을 사용한다.
export const FOLDER_WORKSPACE_BACKDROP_COLOR = 'rgba(0, 0, 0, 0.38)';
export function getFolderWorkspaceOverlayWidth(screenWidth: number) {
  return Math.min(Math.floor(screenWidth * 0.9), 920);
}
export function getCardDetailPaneWidth(overlayWidth: number) {
  return Math.round(overlayWidth * 0.5);
}

/**
 * 이 폭 미만이면 카드 상세와 대화를 한 열에서 단계로 전환한다.
 * 아이폰 듀오 안쪽 세로(669 → 602)는 단일 열, 가로(951 → 855)는 2열을 유지한다.
 */
export const FOLDER_WORKSPACE_SINGLE_PANEL_MAX_WIDTH = 640;
export function shouldUseSinglePanel(overlayWidth: number) {
  return overlayWidth < FOLDER_WORKSPACE_SINGLE_PANEL_MAX_WIDTH;
}

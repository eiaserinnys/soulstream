// 기존 카드 상세 sheet와 PAS 상세가 같은 폭과 배경을 사용한다.
export const FOLDER_WORKSPACE_BACKDROP_COLOR = 'rgba(0, 0, 0, 0.38)';
export function getFolderWorkspaceOverlayWidth(screenWidth: number) {
  return Math.min(Math.floor(screenWidth * 0.9), 920);
}
export function getCardDetailPaneWidth(overlayWidth: number) {
  return Math.round(overlayWidth * 0.5);
}

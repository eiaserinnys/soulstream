// F-H — fetch in-flight 시 사용자 viewport의 위쪽 한계를 frontier로 제한.
//
// inverted FlatList에서 contentOffset.y가 클수록 화면 위쪽(=시간상 과거).
// fetch가 시작되면 frontier 좌표를 그 시점의 contentOffset.y로 고정,
// fetch 완료(또는 실패)까지 사용자가 frontier 너머로 가지 못하게 한다.
//
// 본 모듈은 순수 함수만 export하여 ChatBody 통합 mount 없이 단위 테스트한다
// (sseGate.ts 패턴과 동일 — design-principles §10 인터페이스가 테스트 표면).
//
// frontier 정본은 ChatBody의 fetchFrontierRef. 본 모듈은 frontier 값을 받아
// 동기적 clamp만 수행하며, ref 관리·생애주기는 호출자(ChatBody) 책임.

/**
 * 현재 viewport offset이 frontier를 넘으면 frontier로 clamp한다.
 *
 * @param currentOffset 현재 contentOffset.y (onScroll에서 측정).
 * @param frontier      fetch 발사 시점에 freeze된 좌표. null이면 비활성.
 * @param scrollToOffset clamp 적용 시 호출되는 어댑터 (FlatList.scrollToOffset).
 * @returns clamp 적용 여부 (테스트·로깅용).
 */
export function clampScrollIfNeeded(
  currentOffset: number,
  frontier: number | null,
  scrollToOffset: (offset: number) => void,
): boolean {
  if (frontier === null) return false;
  if (currentOffset <= frontier) return false;
  scrollToOffset(frontier);
  return true;
}

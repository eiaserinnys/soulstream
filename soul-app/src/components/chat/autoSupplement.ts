// 첫 페이지 응답 직후 보충 페치를 발화해야 하는지 결정하는 순수 함수.
// ChatBody의 useEffect가 이 함수를 호출하여 결정한다 (테스트 표면 분리, §10).
//
// 배경: RN FlatList는 같은 viewport 위치에서 onEndReached를 자동 재발화하지 않으므로,
// 첫 페이지가 화면을 못 채우면 사용자가 스크롤하기 전까지 추가 로드가 누락된다.
// 이를 우회하기 위해 첫 페이지 응답 후 cursor가 갱신될 때 1회 자동 보충 페치를 트리거한다.
//
// 반환값:
//  - non-null string: 보충 페치를 이 cursor로 발사할 것
//  - null: 발사하지 말 것
export function decideAutoSupplement(input: {
  alreadySupplemented: boolean;
  historyCursor: string | null | undefined;
  reachedTop: boolean;
}): string | null {
  if (input.alreadySupplemented) return null;
  if (input.historyCursor === undefined) return null;
  if (input.historyCursor === null) return null;
  if (input.reachedTop) return null;
  return input.historyCursor;
}

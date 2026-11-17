/**
 * 손으로 나열한 목록이 유니온의 모든 값을 빠짐없이 담았는지 타입으로 강제한다.
 *
 * 화면 순서를 지키는 배열을 그대로 받아 그대로 돌려준다(런타임 동작 없음).
 * 값이 하나라도 빠지면 `__missing` 자리에 빠진 값이 오류로 드러나고,
 * 유니온 밖의 값이 들어가면 `readonly T[]` 제약에서 오류가 난다.
 */
export function exhaustiveList<T extends string>() {
  return <const L extends readonly T[]>(
    list: L & ([Exclude<T, L[number]>] extends [never] ? unknown : { readonly __missing: Exclude<T, L[number]> }),
  ): L => list;
}

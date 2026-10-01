/**
 * 디자인 폴리시 정적 계약의 의도적인 예외만 둔다.
 * 키는 `상대경로: 정확한 선언문`이다. 파일 전체 면제는 허용하지 않는다.
 * 예외를 추가할 때는 웹 정본 문서의 근거 절과 제거 조건을 함께 적는다.
 */
export const NUMERIC_TYPOGRAPHY_EXCEPTIONS = new Set<string>();
export const NUMERIC_SPACING_EXCEPTIONS = new Set<string>([
  // PR-J: 디렉터 실기기 판정으로 ThinkingEvent는 PR-H 이전의 3pt 행 간격을 그대로 유지한다.
  'components/events/ThinkingEvent.tsx: marginVertical: 3,',
]);
export const NUMERIC_ICON_SIZE_EXCEPTIONS = new Set<string>();

/**
 * 노드 머리의 「18:37 갱신」과 cogito 행의 확인 시각이 같은 표기를 쓰도록 한 곳에 둔다.
 * 24시간 HH:MM으로 적고, 값이 없거나 해석되지 않으면 null이다.
 */
export function clockLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

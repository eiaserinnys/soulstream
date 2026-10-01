export function formatRelativeTime(
  iso: string,
  nowMs: number = Date.now(),
): string {
  const elapsedMinutes = Math.max(
    0,
    Math.floor((nowMs - new Date(iso).getTime()) / 60_000),
  );
  if (elapsedMinutes < 1) return '방금 전';
  if (elapsedMinutes < 60) return `${elapsedMinutes}분 전`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

/**
 * input-request-utils - AskUserQuestion 공유 유틸리티
 */

export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

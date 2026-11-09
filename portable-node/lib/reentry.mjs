/**
 * 재진입 루프 방지는 껍데기(start.sh/start.cmd)가 아니라 launcher가 맡는다.
 * 같은 이유와 키로 다시 75를 요청하는 것은 진행이 아니라 반복이다.
 */
export function isRepeatedReentry(previous, reason, key) {
  return Boolean(previous) && previous.reason === reason && previous.key === key;
}

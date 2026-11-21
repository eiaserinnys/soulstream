export const INPUT_REQUEST_TIMEOUT_SEC = 300;
export function inputRequestRemainingSec(receivedAt: number | undefined, timeoutSec: number): number {
  if (!receivedAt) return timeoutSec;
  return Math.max(0, timeoutSec - Math.floor((Date.now() - receivedAt) / 1000));
}

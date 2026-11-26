export type UpstreamStatus = {
  readonly connected: boolean;
  readonly last_error: string | null;
};

const UNAUTHORIZED_HANDSHAKE = "Unexpected server response: 401";
const LAST_ERROR_MAX_CHARS = 300;

export const UPSTREAM_UNAUTHORIZED_HINT =
  "orch가 연결을 401로 거절했습니다. orch와 이 worker의 AUTH_BEARER_TOKEN이 같은 값인지 확인하세요.";

/** Tracks whether the orch link is up and why the last attempt failed. */
export class UpstreamStatusTracker {
  private connected = false;
  private lastError: string | null = null;
  private unauthorizedHinted = false;

  snapshot(): UpstreamStatus {
    return { connected: this.connected, last_error: this.lastError };
  }

  markConnected(): void {
    this.connected = true;
    this.lastError = null;
    this.unauthorizedHinted = false;
  }

  markDisconnected(): void {
    this.connected = false;
  }

  /** Returns true the first time a 401 is seen in an unbroken run of failures. */
  markFailed(err: unknown): boolean {
    this.connected = false;
    const message = err instanceof Error ? err.message : String(err);
    this.lastError = message.slice(0, LAST_ERROR_MAX_CHARS);
    if (!message.includes(UNAUTHORIZED_HANDSHAKE)) return false;
    const first = !this.unauthorizedHinted;
    this.unauthorizedHinted = true;
    return first;
  }
}

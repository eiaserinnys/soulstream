/**
 * Exponential backoff 재연결 정책. Python `upstream/reconnect.py` 등가:
 * initial 3s · max 60s · ×2.
 *
 * 정책 시퀀스: 3 → 6 → 12 → 24 → 48 → 60 → 60 ...
 */
export class ReconnectPolicy {
  private currentDelay: number;
  private attemptCount = 0;

  constructor(
    private readonly initialDelay = 3.0,
    private readonly maxDelay = 60.0,
    private readonly multiplier = 2.0,
  ) {
    this.currentDelay = initialDelay;
  }

  get attempt(): number {
    return this.attemptCount;
  }

  get currentDelaySeconds(): number {
    return this.currentDelay;
  }

  /** 연결 성공 시 호출. backoff을 초기값으로 리셋. */
  reset(): void {
    this.currentDelay = this.initialDelay;
    this.attemptCount = 0;
  }

  /** 다음 재연결까지 대기. setTimeout 기반. */
  async wait(): Promise<void> {
    this.attemptCount += 1;
    const delayMs = this.currentDelay * 1000;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    this.currentDelay = Math.min(
      this.currentDelay * this.multiplier,
      this.maxDelay,
    );
  }
}

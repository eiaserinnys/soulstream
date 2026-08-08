export const PUSH_NOTIFICATION_DEDUPE_TTL_MS = 60 * 60_000;
export const PUSH_NOTIFICATION_DEDUPE_MAX_ENTRIES = 10_000;

export type PushNotificationEventClaim = {
  readonly eventKey: string;
  readonly duplicate: boolean;
};

export class PushNotificationDedupe {
  private readonly notifiedAtMs = new Map<string, number>();

  claim(
    sessionId: string,
    event: Readonly<Record<string, unknown>>,
    nowMs: number,
  ): PushNotificationEventClaim | undefined {
    const eventId = positiveInteger(event._event_id) ?? positiveInteger(event.id);
    if (eventId === undefined) return undefined;
    const eventKey = `${sessionId}:${eventId}`;
    if (this.notifiedAtMs.has(eventKey)) return { eventKey, duplicate: true };

    this.notifiedAtMs.set(eventKey, nowMs);
    while (this.notifiedAtMs.size > PUSH_NOTIFICATION_DEDUPE_MAX_ENTRIES) {
      const oldest = this.notifiedAtMs.keys().next().value;
      if (oldest === undefined) break;
      this.notifiedAtMs.delete(oldest);
    }
    return { eventKey, duplicate: false };
  }

  get size(): number {
    return this.notifiedAtMs.size;
  }

  sweepExpired(nowMs: number): number {
    let swept = 0;
    for (const [key, notifiedAtMs] of this.notifiedAtMs) {
      if (nowMs - notifiedAtMs < PUSH_NOTIFICATION_DEDUPE_TTL_MS) continue;
      this.notifiedAtMs.delete(key);
      swept += 1;
    }
    return swept;
  }
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

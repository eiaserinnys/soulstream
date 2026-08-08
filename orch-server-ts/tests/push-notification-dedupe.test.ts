import { describe, expect, it } from "vitest";

import {
  PUSH_NOTIFICATION_DEDUPE_MAX_ENTRIES,
  PushNotificationDedupe,
} from "../src/push/push_notification_dedupe.js";

describe("PushNotificationDedupe", () => {
  it("evicts the oldest identity at the hard memory bound", () => {
    const dedupe = new PushNotificationDedupe();
    for (let eventId = 1; eventId <= PUSH_NOTIFICATION_DEDUPE_MAX_ENTRIES + 1; eventId += 1) {
      dedupe.claim("session-a", { _event_id: eventId }, eventId);
    }

    expect(dedupe.size).toBe(PUSH_NOTIFICATION_DEDUPE_MAX_ENTRIES);
    expect(dedupe.claim("session-a", { _event_id: 1 }, 20_000)?.duplicate).toBe(false);
    expect(dedupe.claim(
      "session-a",
      { _event_id: PUSH_NOTIFICATION_DEDUPE_MAX_ENTRIES + 1 },
      20_000,
    )?.duplicate).toBe(true);
  });
});

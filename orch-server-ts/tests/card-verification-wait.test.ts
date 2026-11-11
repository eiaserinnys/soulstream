import { describe, expect, it } from "vitest";
import {
  VERIFICATION_WAIT_MAX_DAYS, formatSeoulWakeTime, parseVerificationWakeAt, validateVerificationWait, verificationWaitNow,
} from "../src/cards/card_verification_wait.js";

const now = new Date("2026-11-11T00:00:00Z");
const day = 24 * 60 * 60 * 1000;

describe("verification wait input", () => {
  it("accepts an offset or Z future time and trims the waiting line", () => {
    expect(validateVerificationWait({ wakeAt: "2026-11-11T10:00:00+09:00", waitingFor: "  배포 뒤 확인  " }, now))
      .toMatchObject({ ok: true, waitingFor: "배포 뒤 확인" });
    const z = validateVerificationWait({ wakeAt: "2026-11-12T09:00:00Z", waitingFor: "실제 사용 확인" }, now);
    expect(z.ok && z.wakeAt.toISOString()).toBe("2026-11-12T09:00:00.000Z");
  });

  it("accepts the exact seven-day boundary and rejects anything past it", () => {
    expect(validateVerificationWait({ wakeAt: new Date(now.getTime() + VERIFICATION_WAIT_MAX_DAYS * day).toISOString(), waitingFor: "경계" }, now).ok).toBe(true);
    expect(validateVerificationWait({ wakeAt: new Date(now.getTime() + VERIFICATION_WAIT_MAX_DAYS * day + 1).toISOString(), waitingFor: "경계" }, now))
      .toMatchObject({ ok: false });
  });

  it.each([
    ["no offset", "2026-11-12T09:00"],
    ["hour out of range", "2026-11-12T25:00:00+09:00"],
    ["minute out of range", "2026-11-12T09:60:00+09:00"],
    ["impossible calendar day", "2026-02-30T09:00:00+09:00"],
    ["not a date", "tomorrow"],
  ])("rejects a %s wake time format", (_label, wakeAt) => {
    expect(parseVerificationWakeAt(wakeAt)).toBeNull();
    expect(validateVerificationWait({ wakeAt, waitingFor: "확인" }, now)).toMatchObject({ ok: false });
  });

  it.each([["past", "2026-11-10T23:59:59Z"], ["equal to now", "2026-11-11T00:00:00Z"]])(
    "rejects a %s wake time that is not in the future", (_label, wakeAt) => {
      expect(parseVerificationWakeAt(wakeAt)).toBeInstanceOf(Date);
      expect(validateVerificationWait({ wakeAt, waitingFor: "확인" }, now)).toMatchObject({ ok: false });
    });

  it("rejects missing fields, blank waiting lines and more than 36 code points", () => {
    expect(validateVerificationWait({}, now)).toMatchObject({ ok: false, message: "검증 대기에는 wake_at과 waiting_for가 필요합니다" });
    expect(validateVerificationWait({ wakeAt: "2026-11-12T09:00:00+09:00" }, now)).toMatchObject({ ok: false });
    expect(validateVerificationWait({ wakeAt: "2026-11-12T09:00:00+09:00", waitingFor: "   " }, now)).toMatchObject({ ok: false });
    expect(validateVerificationWait({ wakeAt: "2026-11-12T09:00:00+09:00", waitingFor: "가".repeat(36) }, now).ok).toBe(true);
    expect(validateVerificationWait({ wakeAt: "2026-11-12T09:00:00+09:00", waitingFor: "가".repeat(37) }, now)).toMatchObject({ ok: false });
    expect(validateVerificationWait({ wakeAt: "2026-11-12T09:00:00+09:00", waitingFor: "😀".repeat(36) }, now).ok).toBe(true);
    expect(validateVerificationWait({ wakeAt: "2026-11-12T09:00:00+09:00", waitingFor: "😀".repeat(37) }, now)).toMatchObject({ ok: false });
  });
});

describe("verification wait display", () => {
  it("formats Seoul time as HH:MM today and M월 D일 HH:MM on another day", () => {
    expect(formatSeoulWakeTime(new Date("2026-11-11T12:30:00+09:00"), now)).toBe("12:30");
    expect(formatSeoulWakeTime(new Date("2026-11-12T09:05:00+09:00"), now)).toBe("11월 12일 09:05");
    // 15:30Z is already the next day in Seoul.
    expect(formatSeoulWakeTime(new Date("2026-11-11T15:30:00Z"), now)).toBe("11월 12일 00:30");
  });

  it("writes the board now line with turn outside and no ask", () => {
    expect(verificationWaitNow("배포 확인", new Date("2026-11-11T12:30:00+09:00"), now, "session-1")).toEqual({
      text: "배포 확인, 12:30에 다시 확인", turn: "outside", ask: null, updatedAt: now.toISOString(), sessionId: "session-1",
    });
  });
});

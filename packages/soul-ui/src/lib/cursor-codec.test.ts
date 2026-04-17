/**
 * cursor-codec 테스트 — ISO8601 타임스탬프와 event_id를 round-trip 할 수 있는지 확인한다.
 *
 * 설계 주의: ISO8601 타임스탬프는 `,`를 포함하지 않으므로,
 * decode는 **마지막 comma** 기준으로 split해야 안전하다.
 */

import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "./cursor-codec";

describe("encodeCursor / decodeCursor", () => {
  it("기본 포맷: ISO8601 + event_id", () => {
    const ts = "2026-04-17T03:45:12.123456+00:00";
    const cursor = encodeCursor(ts, 4821);
    expect(cursor).toBe("2026-04-17T03:45:12.123456+00:00,4821");

    const decoded = decodeCursor(cursor);
    expect(decoded.timestamp).toBe(ts);
    expect(decoded.eventId).toBe(4821);
  });

  it("UTC Z suffix도 동일하게 처리한다", () => {
    const ts = "2026-04-17T03:45:12.123Z";
    const cursor = encodeCursor(ts, 1);
    expect(decodeCursor(cursor)).toEqual({ timestamp: ts, eventId: 1 });
  });

  it("event_id가 큰 정수라도 round-trip한다", () => {
    const ts = "2026-04-17T00:00:00+00:00";
    const id = 9_999_999_999; // 100억 근처
    const cursor = encodeCursor(ts, id);
    expect(decodeCursor(cursor).eventId).toBe(id);
  });

  it("decodeCursor는 **마지막** comma를 기준으로 split한다 (ISO8601에 comma 없음을 전제)", () => {
    // 비표준이지만 timestamp에 comma가 있더라도 마지막 comma 기준이므로 안전하다
    const cursor = "pathological,with,commas,42";
    const { timestamp, eventId } = decodeCursor(cursor);
    expect(timestamp).toBe("pathological,with,commas");
    expect(eventId).toBe(42);
  });

  it("comma가 없으면 에러", () => {
    expect(() => decodeCursor("no-comma")).toThrow(/missing comma/);
  });

  it("빈 timestamp는 거부", () => {
    expect(() => decodeCursor(",42")).toThrow(/empty timestamp/);
  });

  it("event_id가 숫자가 아니면 거부", () => {
    expect(() => decodeCursor("2026-04-17T00:00:00Z,abc")).toThrow(/Invalid cursor event_id/);
  });

  it("event_id가 음수면 거부", () => {
    expect(() => decodeCursor("2026-04-17T00:00:00Z,-1")).toThrow(/Invalid cursor event_id/);
  });

  it("encodeCursor는 빈 timestamp 거부", () => {
    expect(() => encodeCursor("", 1)).toThrow(/timestamp is empty/);
  });

  it("encodeCursor는 소수 eventId 거부", () => {
    expect(() => encodeCursor("2026-04-17T00:00:00Z", 3.14)).toThrow(/invalid eventId/);
  });
});

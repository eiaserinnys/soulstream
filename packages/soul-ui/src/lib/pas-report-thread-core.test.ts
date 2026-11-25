import { describe, expect, it } from "vitest";
import { AGENDA_KIND_LABEL, itemInstructionBody, nextSnoozeReturn, snoozeOptions } from "./pas-report-thread-core";

describe("nextSnoozeReturn", () => {
  const now = Date.parse("2026-11-25T12:00:00.000Z");
  const board = [
    { snoozedUntil: Date.parse("2026-11-25T18:00:00.000Z") },
    { snoozedUntil: Date.parse("2026-11-25T15:00:00.000Z") },
    { snoozedUntil: Date.parse("2026-11-25T11:00:00.000Z") },
    { snoozedUntil: null },
  ];
  it("다음에 돌아올 시각을 알려 준다", () => {
    expect(nextSnoozeReturn(board, now)).toBe(Date.parse("2026-11-25T15:00:00.000Z"));
    expect(nextSnoozeReturn(board, Date.parse("2026-11-25T19:00:00.000Z"))).toBeNull();
  });
});

describe("snoozeOptions", () => {
  it("지금이 18시 전이면 네 선택지를 지역 시각으로 낸다", () => {
    const now = new Date(2026, 10, 25, 10, 30);
    const options = snoozeOptions(now);
    expect(options.map(option => option.label)).toEqual(["1시간 뒤", "오늘 저녁", "내일 아침", "사흘 뒤"]);
    expect(options.map(option => new Date(option.at))).toEqual([new Date(2026, 10, 25, 11, 30), new Date(2026, 10, 25, 19, 0), new Date(2026, 10, 26, 9, 0), new Date(2026, 10, 28, 9, 0)]);
  });
  it("오늘 저녁은 18시 정각부터 뺀다(17:59는 있고 18:00부터 없다)", () => {
    expect(snoozeOptions(new Date(2026, 10, 25, 17, 59)).map(option => option.label)).toContain("오늘 저녁");
    expect(snoozeOptions(new Date(2026, 10, 25, 18, 0)).map(option => option.label)).toEqual(["1시간 뒤", "내일 아침", "사흘 뒤"]);
    expect(snoozeOptions(new Date(2026, 10, 25, 18, 5)).map(option => option.label)).toEqual(["1시간 뒤", "내일 아침", "사흘 뒤"]);
  });
  it("모든 선택지가 지금보다 뒤이고 30일 안이다", () => {
    const now = new Date(2026, 10, 25, 23, 50);
    for (const option of snoozeOptions(now)) {
      expect(option.at).toBeGreaterThan(now.getTime());
      expect(option.at - now.getTime()).toBeLessThan(30 * 86_400_000);
    }
  });
});

describe("itemInstructionBody", () => {
  it("질문이 열려 있을 때 항목 지시는 글 앞에 번호를 적는다", () => {
    expect(itemInstructionBody(3, "다시 확인해줘")).toBe("3번 항목: 다시 확인해줘");
  });
});

describe("AGENDA_KIND_LABEL", () => {
  it("안건 종류마다 글자가 하나씩 있다", () => {
    expect(Object.keys(AGENDA_KIND_LABEL).sort()).toEqual(["blocked", "question", "request", "review", "running", "verifying"]);
  });
});

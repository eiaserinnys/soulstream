import { CARD_VERIFICATION_WAKE_AT_PATTERN } from "@soulstream/mcp-contract";
import { makeCardNow, type CardNow } from "./card_item_rules.js";

/** 검증 대기는 이 기간을 넘는 시각을 받지 않는다. 설정 시점의 경계 검증이며 DB CHECK가 아니다. */
export const VERIFICATION_WAIT_MAX_DAYS = 7;
export const WAITING_FOR_MAX_CODE_POINTS = 36;
const DAY_MS = 24 * 60 * 60 * 1000;
const SEOUL_TIME_ZONE = "Asia/Seoul";

/** 형식 규칙의 정본은 MCP 도구 스키마와 같은 상수다. 오프셋이 없으면 서버 시간대에 따라 시각이 달라진다. */
const ISO_WAKE_AT = CARD_VERIFICATION_WAKE_AT_PATTERN;

export type VerificationWaitCheck =
  | { ok: true; wakeAt: Date; waitingFor: string }
  | { ok: false; message: string };

/** 형식과 달력 유효성만 본다. 지금보다 뒤인지와 7일 이내인지는 검증 대기 상태에서 따진다. */
export function parseVerificationWakeAt(value: string): Date | null {
  const match = ISO_WAKE_AT.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day)
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

export function validateVerificationWait(
  input: { wakeAt?: string; waitingFor?: string },
  now: Date,
): VerificationWaitCheck {
  if (input.wakeAt === undefined || input.waitingFor === undefined)
    return { ok: false, message: "검증 대기에는 wake_at과 waiting_for가 필요합니다" };
  const waitingFor = input.waitingFor.trim();
  const length = [...waitingFor].length;
  if (length === 0) return { ok: false, message: "waiting_for를 한 줄로 적으세요" };
  if (length > WAITING_FOR_MAX_CODE_POINTS)
    return { ok: false, message: `waiting_for는 ${WAITING_FOR_MAX_CODE_POINTS}자까지입니다. 지금 ${length}자입니다` };
  const wakeAt = parseVerificationWakeAt(input.wakeAt);
  if (!wakeAt) return { ok: false, message: "wake_at은 오프셋이 있는 ISO 8601 시각이어야 합니다" };
  if (wakeAt.getTime() <= now.getTime()) return { ok: false, message: "wake_at은 지금보다 뒤여야 합니다" };
  if (wakeAt.getTime() - now.getTime() > VERIFICATION_WAIT_MAX_DAYS * DAY_MS)
    return { ok: false, message: `wake_at은 지금부터 ${VERIFICATION_WAIT_MAX_DAYS}일 이내여야 합니다` };
  return { ok: true, wakeAt, waitingFor };
}

/** 서울 기준 오늘은 HH:MM, 다른 날은 M월 D일 HH:MM으로 적는다. */
export function formatSeoulWakeTime(wakeAt: Date, now: Date): string {
  const wake = seoulParts(wakeAt);
  const today = seoulParts(now);
  const clock = `${String(wake.hour).padStart(2, "0")}:${String(wake.minute).padStart(2, "0")}`;
  return wake.year === today.year && wake.month === today.month && wake.day === today.day
    ? clock
    : `${wake.month}월 ${wake.day}일 ${clock}`;
}

export function verificationWaitNow(waitingFor: string, wakeAt: Date, at: Date, sessionId: string | null): CardNow {
  return makeCardNow(
    { text: `${waitingFor}, ${formatSeoulWakeTime(wakeAt, at)}에 다시 확인`, turn: "outside" },
    at.toISOString(),
    sessionId,
  );
}

function seoulParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SEOUL_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

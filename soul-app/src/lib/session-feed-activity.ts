import type { Session } from '../api/types';

const FEED_MESSAGE_TYPES = new Set(['user_message', 'assistant_message']);
const MAX_PREVIEW_CODE_POINTS = 200;
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

type SessionLastMessage = NonNullable<Session['lastMessage']>;

/**
 * 피드 preview로 승격할 수 있는 wire last_message의 단일 경계.
 *
 * 서버의 현 필드 모양은 유지하되, 원본 이벤트 타입·blank preview·깨진 timestamp가
 * 기존의 유효 preview와 피드 활동시각을 덮지 못하게 한다.
 */
export function normalizeFeedLastMessage(value: unknown): SessionLastMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string' || !FEED_MESSAGE_TYPES.has(record.type)) {
    return null;
  }
  if (typeof record.preview !== 'string') return null;
  const preview = record.preview.trim();
  if (!preview) return null;
  if (hasMoreThanCodePoints(preview, MAX_PREVIEW_CODE_POINTS)) return null;
  if (!isValidIsoDateTime(record.timestamp)) return null;
  const rawEventId = record.eventId ?? record.event_id;
  if (
    rawEventId !== undefined
    && (!Number.isSafeInteger(rawEventId) || (rawEventId as number) <= 0)
  ) {
    return null;
  }
  return {
    type: record.type,
    ...(rawEventId !== undefined ? { eventId: rawEventId as number } : {}),
    preview,
    timestamp: record.timestamp,
  };
}

function hasMoreThanCodePoints(value: string, limit: number): boolean {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > limit) return true;
  }
  return false;
}

export function isValidIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE_TIME.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  return (
    month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth(year, month)
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59
  );
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** 최신 유효 채팅 메시지를 우선하는 피드 활동시각 정본. */
export function getSessionFeedActivityTimestamp(session: Session): string | null {
  const lastMessage = normalizeFeedLastMessage(session.lastMessage);
  if (lastMessage?.timestamp) return lastMessage.timestamp;
  if (isValidIsoDateTime(session.createdAt)) return session.createdAt;
  // 마이그레이션 전 snapshot을 위한 최후 fallback. 정상 wire에서는 createdAt이 존재한다.
  if (isValidIsoDateTime(session.updatedAt)) return session.updatedAt;
  return null;
}

export function getSessionFeedActivityMs(session: Session): number | null {
  const timestamp = getSessionFeedActivityTimestamp(session);
  return timestamp ? Date.parse(timestamp) : null;
}

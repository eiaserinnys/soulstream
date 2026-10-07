import type { SessionReadPeriod } from "@soulstream/mcp-contract";

export function serializeDate(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString();
}

const OFFSET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** 오프셋이 명시된 ISO 8601 형식만 받는다. 형식이 맞지 않으면 null. */
export function parseOffsetTimestamp(value: string): Date | null {
  if (!OFFSET_TIMESTAMP.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function parseSessionReadPeriod(
  since: string | undefined,
  until: string | undefined,
): { period?: SessionReadPeriod; error?: string } {
  if (since === undefined && until === undefined) return {};
  if (since === undefined || until === undefined) {
    return { error: "since와 until을 함께 지정해야 합니다." };
  }
  const sinceDate = parseOffsetTimestamp(since);
  const untilDate = parseOffsetTimestamp(until);
  if (!sinceDate) {
    return { error: `since는 오프셋이 명시된 ISO 8601 시각이어야 합니다: ${since}` };
  }
  if (!untilDate) {
    return { error: `until은 오프셋이 명시된 ISO 8601 시각이어야 합니다: ${until}` };
  }
  if (sinceDate.getTime() >= untilDate.getTime()) {
    return { error: "since는 until보다 앞서야 합니다." };
  }
  return {
    period: {
      since: sinceDate.toISOString(),
      until: untilDate.toISOString(),
    },
  };
}

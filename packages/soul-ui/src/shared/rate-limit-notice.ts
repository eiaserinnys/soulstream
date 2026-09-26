const KST_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatRateLimitNotice(
  message: string,
  rateLimitType?: string,
  resetsAt?: string,
  nowMs = Date.now(),
): string {
  const details: string[] = [];
  const limitLabel = getLimitLabel(rateLimitType);
  if (limitLabel) details.push(limitLabel);

  const resetMs = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt);
  if (Number.isFinite(resetMs)) {
    details.push(`해제 시각 ${formatKst(resetMs)}`);
    const remaining = formatRemaining(resetMs - nowMs);
    details.push(remaining);
  }

  return details.length === 0
    ? message
    : `${message}\n\n${details.join(" · ")}`;
}

function getLimitLabel(rateLimitType?: string): string | undefined {
  if (rateLimitType === "five_hour") return "5시간 한도";
  if (rateLimitType === "seven_day" || rateLimitType?.startsWith("seven_day_")) {
    return "주간 한도";
  }
  return undefined;
}

function formatKst(timestamp: number): string {
  const parts = Object.fromEntries(
    KST_FORMAT.formatToParts(timestamp).map(({ type, value }) => [type, value]),
  );
  return `${parts.month}월 ${parts.day}일 ${parts.hour}:${parts.minute} KST`;
}

function formatRemaining(deltaMs: number): string {
  if (deltaMs <= 0) return "이미 해제됨";
  const totalMinutes = Math.ceil(deltaMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}일 ${hours}시간 남음` : `${days}일 남음`;
  if (hours > 0) return minutes > 0 ? `${hours}시간 ${minutes}분 남음` : `${hours}시간 남음`;
  return `${minutes}분 남음`;
}

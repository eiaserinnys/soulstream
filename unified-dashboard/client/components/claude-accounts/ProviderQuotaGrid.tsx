import type { ProviderQuotaSlot, ProviderQuotaSlots } from "@seosoyoung/soul-ui";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const SEVEN_DAYS_MS = 7 * 86_400_000;

function clockText(date: Date): string {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

/**
 * 한도 칸의 초기화 표기. Claude 계정 행이 쓰던 표기를 그대로 옮겨,
 * 요약 스냅숏(에포크 초)과 계정 사용량(ISO 문자열)을 같은 함수로 읽는다.
 * 월간처럼 긴 창은 요일과 시각 대신 날짜로 적는다.
 */
export function formatQuotaResetLabel(
  resetAtEpochSeconds: number | null,
  usedPercent: number,
  kind?: ProviderQuotaSlot["kind"],
): string {
  if (resetAtEpochSeconds === null) return "";
  const reset = new Date(resetAtEpochSeconds * 1000);
  if (!Number.isFinite(reset.getTime())) return "";
  const roundedUsed = Math.round(usedPercent);
  const diffMs = reset.getTime() - Date.now();
  const isMonthlyOrLong = kind === "monthly" || diffMs >= SEVEN_DAYS_MS;
  const dateLabel = `${reset.getMonth() + 1}/${reset.getDate()}`;
  if (roundedUsed >= 100) return isMonthlyOrLong ? `${dateLabel} 해제` : `${clockText(reset)} 해제`;
  const minutes = Math.max(0, Math.ceil(diffMs / 60_000));
  if (minutes < 60) return `${minutes}분 후`;
  if (minutes < 12 * 60) return `${Math.ceil(minutes / 60)}시간 후`;
  return isMonthlyOrLong ? dateLabel : `${WEEKDAYS[reset.getDay()]} ${clockText(reset)}`;
}

export function quotaColor(usedPercent: number): string {
  if (usedPercent >= 95) return "var(--color-red-500)";
  if (usedPercent >= 80) return "var(--color-amber-500)";
  return "var(--v3-accent)";
}

function ProviderQuotaCell({ slot }: { slot: ProviderQuotaSlot }) {
  const used = Math.min(100, Math.max(0, slot.usedPercent));
  return <div className="c724-quota-cell">
    <div className="c724-quota-label-row">
      <span className="c724-quota-name">{slot.label}</span>
      <span className="c724-quota-pct">{Math.round(slot.usedPercent)}%</span>
      <span className="c724-quota-reset">{formatQuotaResetLabel(slot.resetAt, slot.usedPercent, slot.kind)}</span>
    </div>
    <div className="c724-quota-track" aria-hidden="true">
      <div className="c724-quota-fill" style={{ width: `${used}%`, backgroundColor: quotaColor(used) }} />
    </div>
  </div>;
}

export function ProviderQuotaSkeleton() {
  return <div className="c724-quota-grid" data-testid="provider-quota-skeleton" aria-hidden="true">
    {[0, 1, 2].map((index) => <div key={index} className="c724-quota-cell">
      {/* 값이 들어올 때와 같은 줄 높이를 차지해 막대가 튀지 않게 한다. */}
      <div className="c724-quota-label-row c724-quota-skeleton-label">
        <span className="c724-quota-name">5시간</span>
        <span className="c724-quota-pct">0%</span>
        <span className="c724-quota-reset">0시간 후</span>
      </div>
      <div className="c724-quota-track animate-pulse" />
    </div>)}
  </div>;
}

export function ProviderQuotaGrid({ slots, label }: { slots: ProviderQuotaSlots; label: string }) {
  return <div className="c724-quota-grid" aria-label={label}>
    {slots.map((slot, index) => slot === null
      ? <div key={`empty-${index}`} className="c724-quota-cell" aria-hidden="true" />
      : <ProviderQuotaCell key={slot.kind} slot={slot} />)}
  </div>;
}

import type { ProviderQuotaSlot, ProviderQuotaSlots } from "@seosoyoung/soul-ui";

/**
 * 한도 칸의 초기화 표기. Claude 계정 행이 쓰던 표기를 그대로 옮겨,
 * 요약 스냅숏(에포크 초)과 계정 사용량(ISO 문자열)을 같은 함수로 읽는다.
 */
export function formatQuotaResetLabel(resetAtEpochSeconds: number | null, usedPercent: number): string {
  if (resetAtEpochSeconds === null) return "";
  const reset = new Date(resetAtEpochSeconds * 1000);
  if (!Number.isFinite(reset.getTime())) return "";
  if (usedPercent >= 100) {
    const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(reset);
    return `${time} 해제`;
  }
  const minutes = Math.max(0, Math.ceil((reset.getTime() - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}분 후`;
  if (minutes < 12 * 60) return `${Math.ceil(minutes / 60)}시간 후`;
  return new Intl.DateTimeFormat("ko-KR", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(reset);
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
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="c724-quota-pct">{Math.round(slot.usedPercent)}%</span>
        <span className="c724-quota-reset">{formatQuotaResetLabel(slot.resetAt, slot.usedPercent)}</span>
      </div>
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
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="c724-quota-pct">0%</span>
          <span className="c724-quota-reset">0시간 후</span>
        </div>
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

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { sevenDayElapsedFraction, type ProviderQuotaSlot } from "@seosoyoung/soul-ui";

export type QuotaWindow = Omit<ProviderQuotaSlot, "label">;
const SEVEN_DAYS_MS = 7 * 86_400_000;

function clockText(date: Date, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, {
    hour: locale === "ko" ? "2-digit" : "numeric",
    minute: "2-digit",
    ...(locale === "ko" ? { hour12: false } : {}),
  }).format(date);
}

export function accountClockLabel(value: string | null, locale: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? clockText(date, locale) : null;
}

export function formatQuotaResetLabel(
  resetAtEpochSeconds: number | null,
  usedPercent: number,
  kind: QuotaWindow["kind"] | undefined,
  t: ReturnType<typeof useTranslation>["t"],
  locale: string | undefined,
): string {
  if (resetAtEpochSeconds === null) return "—";
  const reset = new Date(resetAtEpochSeconds * 1000);
  if (!Number.isFinite(reset.getTime())) return "—";
  const roundedUsed = Math.round(usedPercent);
  const diffMs = reset.getTime() - Date.now();
  const isMonthlyOrLong = kind === "monthly" || diffMs >= SEVEN_DAYS_MS;
  const dateLabel = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(reset);
  if (roundedUsed >= 100) {
    return t("accounts.quota.resetAt", { time: isMonthlyOrLong ? dateLabel : clockText(reset, locale) });
  }
  const minutes = Math.max(0, Math.ceil(diffMs / 60_000));
  const number = new Intl.NumberFormat(locale);
  if (minutes < 60) return t("accounts.quota.inMinutes", { number: number.format(minutes) });
  if (minutes < 12 * 60) return t("accounts.quota.inHours", { number: number.format(Math.ceil(minutes / 60)) });
  if (isMonthlyOrLong) return dateLabel;
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(reset);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(reset);
  return t("accounts.quota.weekdayTime", { weekday, time });
}

export function quotaColor(usedPercent: number): string {
  if (usedPercent >= 95) return "var(--color-red-500)";
  if (usedPercent >= 80) return "var(--color-amber-500)";
  return "var(--v3-accent)";
}

function ProviderQuotaCell({ slot }: { slot: QuotaWindow }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const percent = new Intl.NumberFormat(locale, { style: "percent" });
  const used = Math.min(100, Math.max(0, slot.usedPercent));
  // 커서는 데이터가 새로 그려질 때 함께 다시 잰다. 따로 도는 타이머는 두지 않는다.
  const elapsed = slot.sevenDay ? sevenDayElapsedFraction(slot.resetAt, Date.now()) : null;
  const track = <div className={slot.sevenDay ? "c724-quota-track c724-quota-track--week" : "c724-quota-track"} aria-hidden="true">
    <div className="c724-quota-fill" style={{ width: `${used}%`, backgroundColor: quotaColor(used) }} />
  </div>;
  return <div className="c724-quota-cell">
    <div className="c724-quota-label-row">
      <span className="c724-quota-name">{slot.kind === "fable" ? "Fable" : t(`accounts.quota.${slot.kind}`)}</span>
      <span data-v3-selectable-content="true" className="c724-quota-pct">{percent.format(Math.round(slot.usedPercent) / 100)}</span>
      <span data-v3-selectable-content="true" className="c724-quota-reset">{formatQuotaResetLabel(slot.resetAt, slot.usedPercent, slot.kind, t, locale)}</span>
    </div>
    {slot.sevenDay
      ? <div className="c724-quota-bar" data-week="true"
        style={elapsed === null ? undefined : { "--c724-quota-elapsed": elapsed } as CSSProperties}>
        {track}
        {elapsed === null ? null : <span className="c724-quota-pace-cursor" aria-hidden="true" />}
      </div>
      : track}
  </div>;
}

export function ProviderQuotaSkeleton() {
  const { t, i18n } = useTranslation();
  return <div className="c724-quota-grid" data-testid="provider-quota-skeleton" aria-hidden="true">
    {[0, 1, 2].map((index) => <div key={index} className="c724-quota-cell">
      {/* 값이 들어올 때와 같은 줄 높이를 차지해 막대가 튀지 않게 한다. */}
      <div className="c724-quota-label-row c724-quota-skeleton-label">
        <span className="c724-quota-name">{t("accounts.quota.short")}</span>
        <span className="c724-quota-pct">{new Intl.NumberFormat(i18n.resolvedLanguage, { style: "percent" }).format(0)}</span>
        <span className="c724-quota-reset">{t("accounts.quota.inHours", { number: 0 })}</span>
      </div>
      <div className="c724-quota-track animate-pulse" />
    </div>)}
  </div>;
}

export function ProviderQuotaGrid({ slots, label }: { slots: readonly (QuotaWindow | null)[]; label: string }) {
  return <div className="c724-quota-grid" aria-label={label}>
    {slots.map((slot, index) => slot === null
      ? <div key={`empty-${index}`} className="c724-quota-cell" aria-hidden="true" />
      : <ProviderQuotaCell key={slot.kind} slot={slot} />)}
  </div>;
}

import { intlLocale, resolveLanguage } from "@soulstream/i18n";
import { adminTranslation, dashboardLanguage } from "../components/config/admin-translation";
import type { useTranslation } from "react-i18next";
import type { ModelPresetAvailability } from "@seosoyoung/soul-ui/lib/model-preset-availability";

type Translate = ReturnType<typeof useTranslation>["t"];

export const modelPresetFetchError = (t: Translate) => t("accounts.models.loadError");
export const noAvailableModelMessage = (t: Translate) => t("accounts.models.none");

export function modelPresetOptionLabel(
  preset: ModelPresetAvailability,
  formatResetTime?: (value: string) => string | null,
  includeUsageWarning = true,
  t: Translate = adminTranslation(),
  locale?: string,
): string {
  const resetTime = preset.resets_at
    ? (formatResetTime ?? ((value) => localResetTime(value, locale)))(preset.resets_at)
    : null;
  const reset = resetTime ? t("accounts.quota.resets", { value: resetTime }) : null;
  if (preset.available) {
    const warning = preset.usage_warning && includeUsageWarning ? ` (${t("accounts.quota.delayed")})` : "";
    if (preset.reason === "quota_exhausted" && preset.reason_label) {
      return `${preset.label} (${preset.reason_label}${reset ? `, ${reset}` : ""})${warning}`;
    }
    return `${preset.label}${warning}`;
  }
  const reason = preset.reason_label ? ` (${preset.reason_label})` : "";
  return `${preset.label}${reason}${reset ? ` · ${reset}` : ""}`;
}

/** Reason column text for a row that is blocked or has used up its included quota. */
export function modelPresetReasonText(
  preset: ModelPresetAvailability,
  t: Translate = adminTranslation(),
  locale?: string,
): string | null {
  if (!preset.reason_label) return null;
  if (preset.available && preset.reason !== "quota_exhausted") return null;
  const resetTime = preset.resets_at ? localResetTime(preset.resets_at, locale) : null;
  return `${preset.reason_label}${resetTime ? ` · ${t("accounts.quota.resets", { value: resetTime })}` : ""}`;
}

export function hasNoAvailableModelPreset(
  catalog: { status: string; presets: readonly ModelPresetAvailability[] },
): boolean {
  return catalog.status === "ready" && !catalog.presets.some((preset) => preset.available);
}

/** Puts the picked agent's backend first and keeps the catalog order inside each group. */
export function modelPresetsByAgentBackend(
  presets: readonly ModelPresetAvailability[],
  agentBackend: string | null | undefined,
): readonly ModelPresetAvailability[] {
  if (!agentBackend) return presets;
  return [
    ...presets.filter((preset) => preset.backend === agentBackend),
    ...presets.filter((preset) => preset.backend !== agentBackend),
  ];
}

export function modelPresetSelectionState(
  selectedId: string,
  presets: readonly ModelPresetAvailability[],
  loaded: boolean,
  t: Translate = adminTranslation(),
): {
  preset: ModelPresetAvailability | null;
  valid: boolean;
  warning: string | null;
} {
  if (!selectedId) return { preset: null, valid: true, warning: null };
  if (!loaded) return { preset: null, valid: true, warning: null };
  const preset = presets.find((candidate) => candidate.id === selectedId) ?? null;
  if (!preset) {
    return { preset: null, valid: false, warning: t("accounts.models.unavailable") };
  }
  if (!preset.available) {
    return { preset, valid: false, warning: t("accounts.models.unavailable") };
  }
  return { preset, valid: true, warning: null };
}

export function modelPresetDisplayLabel({
  selectedId,
  preset,
  status,
  missingLabel,
}: {
  selectedId: string;
  preset: ModelPresetAvailability | null;
  status: "idle" | "loading" | "ready" | "error";
  missingLabel?: string;
}, t: Translate = adminTranslation(), locale?: string): string {
  if (status === "error") return t("accounts.models.loadError");
  if (preset) return modelPresetOptionLabel(preset, undefined, false, t, locale);
  if (status === "loading") {
    return selectedId ? t("accounts.models.checkingSelected") : t("accounts.common.loading");
  }
  return selectedId ? missingLabel ?? t("accounts.models.selected") : t("accounts.models.unspecified");
}

function localResetTime(value: string, locale?: string): string | null {
  const now = new Date();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;

  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const language = locale ? resolveLanguage(locale, []) : dashboardLanguage();
  const formatLocale = intlLocale(language);
  const time = new Intl.DateTimeFormat(formatLocale, {
    hour: "2-digit",
    minute: "2-digit",
    ...(language === "en" ? {} : { hourCycle: "h23" }),
  }).format(date);
  if (isToday) return time;
  const day = new Intl.DateTimeFormat(formatLocale, { month: "numeric", day: "numeric" }).format(date);
  return `${day} ${time}`;
}

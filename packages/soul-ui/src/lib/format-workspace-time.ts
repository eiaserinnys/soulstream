import { intlLocale, type Language } from "@soulstream/i18n";

export function formatWorkspaceTime(value: string | undefined | null, language: Language = "ko"): string {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return "...";
  return new Intl.DateTimeFormat(intlLocale(language), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

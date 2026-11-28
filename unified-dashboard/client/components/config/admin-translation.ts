import { createI18n, resolveLanguage, type Language } from "@soulstream/i18n";

export type AdminTranslate = ReturnType<typeof createI18n>["t"];

const translators = new Map<Language, AdminTranslate>();

export function dashboardLanguage(): Language | undefined {
  const documentLanguage = typeof document === "undefined" ? "" : document.documentElement.lang;
  return documentLanguage ? resolveLanguage(documentLanguage, [documentLanguage]) : undefined;
}

export function adminTranslation(): AdminTranslate {
  const language = dashboardLanguage() ?? "ko";
  let t = translators.get(language);
  if (!t) {
    t = createI18n(language).t;
    translators.set(language, t);
  }
  return t;
}

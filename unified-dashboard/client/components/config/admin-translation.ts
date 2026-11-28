import { createI18n, resolveLanguage, type Language } from "@soulstream/i18n";

export type AdminTranslate = ReturnType<typeof createI18n>["t"];

const translators = new Map<Language, AdminTranslate>();

export function adminTranslation(): AdminTranslate {
  const language = typeof document === "undefined" || !document.documentElement.lang
    ? "ko"
    : resolveLanguage(document.documentElement.lang, []);
  let t = translators.get(language);
  if (!t) {
    t = createI18n(language).t;
    translators.set(language, t);
  }
  return t;
}

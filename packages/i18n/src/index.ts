import { createInstance, type i18n } from "i18next";
import ko from "./locales/ko.json";
import en from "./locales/en.json";

export const supportedLanguages = [
  { code: "ko", name: "한국어" }, // i18n-ignore
  { code: "en", name: "English" },
] as const;
export type Language = typeof supportedLanguages[number]["code"];

export function resolveLanguage(account: unknown, browser: readonly string[]): Language {
  if (account === "ko" || account === "en") return account;
  for (const language of browser) {
    const base = language.toLowerCase().split("-")[0];
    if (base === "ko" || base === "en") return base;
  }
  return "en";
}

export function createI18n(language: Language): i18n {
  const instance = createInstance();
  void instance.init({
    lng: language,
    fallbackLng: language === "ko" ? ["en"] : ["ko"],
    resources: { ko: { translation: ko }, en: { translation: en } },
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  return instance;
}

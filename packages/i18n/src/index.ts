import { createInstance, type i18n } from "i18next";
import koAuth from "./locales/ko/auth.json";
import koSettings from "./locales/ko/settings.json";
import koUi from "./locales/ko/ui.json";
import koAgents from "./locales/ko/agents.json";
import koMcp from "./locales/ko/mcp.json";
import koAccounts from "./locales/ko/accounts.json";
import koWebhooks from "./locales/ko/webhooks.json";
import koJobs from "./locales/ko/jobs.json";
import koAdmin from "./locales/ko/admin.json";
import koCards from "./locales/ko/cards.json";
import koFolders from "./locales/ko/folders.json";
import koPersistent from "./locales/ko/persistent.json";
import koSessions from "./locales/ko/sessions.json";
import enAuth from "./locales/en/auth.json";
import enSettings from "./locales/en/settings.json";
import enUi from "./locales/en/ui.json";
import enAgents from "./locales/en/agents.json";
import enMcp from "./locales/en/mcp.json";
import enAccounts from "./locales/en/accounts.json";
import enWebhooks from "./locales/en/webhooks.json";
import enJobs from "./locales/en/jobs.json";
import enAdmin from "./locales/en/admin.json";
import enCards from "./locales/en/cards.json";
import enFolders from "./locales/en/folders.json";
import enPersistent from "./locales/en/persistent.json";
import enSessions from "./locales/en/sessions.json";

export const dictionaries = {
  ko: { auth: koAuth, settings: koSettings, ui: koUi, agents: koAgents, mcp: koMcp, accounts: koAccounts, webhooks: koWebhooks, jobs: koJobs, admin: koAdmin, cards: koCards, folders: koFolders, persistent: koPersistent, sessions: koSessions },
  en: { auth: enAuth, settings: enSettings, ui: enUi, agents: enAgents, mcp: enMcp, accounts: enAccounts, webhooks: enWebhooks, jobs: enJobs, admin: enAdmin, cards: enCards, folders: enFolders, persistent: enPersistent, sessions: enSessions },
};

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
    resources: { ko: { translation: dictionaries.ko }, en: { translation: dictionaries.en } },
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  return instance;
}

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
import jaAuth from "./locales/ja/auth.json";
import jaSettings from "./locales/ja/settings.json";
import jaUi from "./locales/ja/ui.json";
import jaAgents from "./locales/ja/agents.json";
import jaMcp from "./locales/ja/mcp.json";
import jaAccounts from "./locales/ja/accounts.json";
import jaWebhooks from "./locales/ja/webhooks.json";
import jaJobs from "./locales/ja/jobs.json";
import jaAdmin from "./locales/ja/admin.json";
import jaCards from "./locales/ja/cards.json";
import jaFolders from "./locales/ja/folders.json";
import jaPersistent from "./locales/ja/persistent.json";
import jaSessions from "./locales/ja/sessions.json";
import zhHansAuth from "./locales/zh-Hans/auth.json";
import zhHansSettings from "./locales/zh-Hans/settings.json";
import zhHansUi from "./locales/zh-Hans/ui.json";
import zhHansAgents from "./locales/zh-Hans/agents.json";
import zhHansMcp from "./locales/zh-Hans/mcp.json";
import zhHansAccounts from "./locales/zh-Hans/accounts.json";
import zhHansWebhooks from "./locales/zh-Hans/webhooks.json";
import zhHansJobs from "./locales/zh-Hans/jobs.json";
import zhHansAdmin from "./locales/zh-Hans/admin.json";
import zhHansCards from "./locales/zh-Hans/cards.json";
import zhHansFolders from "./locales/zh-Hans/folders.json";
import zhHansPersistent from "./locales/zh-Hans/persistent.json";
import zhHansSessions from "./locales/zh-Hans/sessions.json";

export const dictionaries = {
  ko: { auth: koAuth, settings: koSettings, ui: koUi, agents: koAgents, mcp: koMcp, accounts: koAccounts, webhooks: koWebhooks, jobs: koJobs, admin: koAdmin, cards: koCards, folders: koFolders, persistent: koPersistent, sessions: koSessions },
  en: { auth: enAuth, settings: enSettings, ui: enUi, agents: enAgents, mcp: enMcp, accounts: enAccounts, webhooks: enWebhooks, jobs: enJobs, admin: enAdmin, cards: enCards, folders: enFolders, persistent: enPersistent, sessions: enSessions },
  ja: { auth: jaAuth, settings: jaSettings, ui: jaUi, agents: jaAgents, mcp: jaMcp, accounts: jaAccounts, webhooks: jaWebhooks, jobs: jaJobs, admin: jaAdmin, cards: jaCards, folders: jaFolders, persistent: jaPersistent, sessions: jaSessions },
  "zh-Hans": { auth: zhHansAuth, settings: zhHansSettings, ui: zhHansUi, agents: zhHansAgents, mcp: zhHansMcp, accounts: zhHansAccounts, webhooks: zhHansWebhooks, jobs: zhHansJobs, admin: zhHansAdmin, cards: zhHansCards, folders: zhHansFolders, persistent: zhHansPersistent, sessions: zhHansSessions },
};

export const supportedLanguages = [
  { code: "ko", name: "한국어" }, // i18n-ignore
  { code: "en", name: "English" },
  { code: "ja", name: "日本語" },
  { code: "zh-Hans", name: "简体中文" },
] as const;
export type Language = typeof supportedLanguages[number]["code"];

export function isLanguage(value: unknown): value is Language {
  return supportedLanguages.some(({ code }) => code === value);
}

export function resolveLanguage(account: unknown, browser: readonly string[]): Language {
  if (isLanguage(account)) return account;
  for (const language of browser) {
    const tag = language.toLowerCase();
    const base = tag.split("-")[0];
    if (base === "ko" || base === "en" || base === "ja") return base;
    if (tag === "zh" || tag === "zh-cn" || tag === "zh-sg" || tag === "zh-hans" || tag.startsWith("zh-hans-")) {
      return "zh-Hans";
    }
  }
  return "en";
}

const intlLocales = {
  ko: "ko-KR",
  en: "en-US",
  ja: "ja-JP",
  "zh-Hans": "zh-Hans-CN",
} satisfies Record<Language, string>;

export function intlLocale(language: Language): string {
  return intlLocales[language];
}

export function createI18n(language: Language): i18n {
  const instance = createInstance();
  void instance.init({
    lng: language,
    fallbackLng: { en: ["ko"], default: ["en"] },
    resources: Object.fromEntries(
      Object.entries(dictionaries).map(([code, translation]) => [code, { translation }]),
    ),
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  return instance;
}

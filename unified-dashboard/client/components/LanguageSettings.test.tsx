/** @vitest-environment jsdom */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "@soulstream/i18n";
import { useUserPreferencesSync } from "@seosoyoung/soul-ui/hooks/useUserPreferencesSync";
import { LanguageSettings } from "./LanguageSettings";

describe("language settings", () => {
  it("switches the tab to English and saves the account preference", async () => {
    const i18n = await createI18n("ko");
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => ({ ok: true, json: async () => ({ email: "user@example.com", preferences: options?.body ? JSON.parse(String(options.body)) : { language: "ko" } }) }));
    vi.stubGlobal("fetch", fetchMock);
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    function Page() { useUserPreferencesSync("user@example.com"); return createElement(LanguageSettings); }
    await act(async () => { root.render(createElement(I18nextProvider, { i18n }, createElement(Page))); await new Promise(r => setTimeout(r, 10)); });
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="언어"]');
    expect(trigger).not.toBeNull();
    await act(async () => { trigger!.click(); });
    const english = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent === "English");
    expect(english).toBeDefined();
    await act(async () => {
      const enter = new MouseEvent("pointerover", { bubbles: true });
      Object.defineProperty(enter, "pointerType", { value: "touch" });
      english!.dispatchEvent(enter);
      english!.click();
    });
    await act(async () => { await new Promise(r => setTimeout(r, 400)); });
    expect(host.textContent).toContain("Language");
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "PUT" && JSON.parse(String(options.body)).language === "en")).toBe(true);
    await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
  });
});

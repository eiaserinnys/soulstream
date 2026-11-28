/** @vitest-environment jsdom */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "@soulstream/i18n";
import { Login } from "./Login";
vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => ({ passwordLoginEnabled: true, passwordLogin: vi.fn() }) }));
describe("login language", () => {
  it.each([["en", "Sign in to continue"], ["ko", "계속하려면 로그인하세요"]] as const)("renders %s", async (language, message) => {
    const i18n = await createI18n(language);
    const host = document.createElement("div");
    const root = createRoot(host);
    flushSync(() => root.render(createElement(I18nextProvider, { i18n }, createElement(Login))));
    expect(host.textContent).toContain(message);
    flushSync(() => root.unmount());
  });
});

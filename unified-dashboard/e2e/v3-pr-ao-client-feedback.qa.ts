import type { Browser, Locator, Page, Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_AO_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-pr-ao-client-feedback"),
);
const authExpiredMessage = "로그인이 만료되었습니다. 다시 로그인해 주세요";

const result = await runPlaywrightLifecycle({
  lockName: "pr-ao-v3-client-feedback",
  timeoutMs: 180_000,
}, async ({ browser }) => ({
  dark: await verifyTheme(browser, "dark"),
  light: await verifyTheme(browser, "light"),
  authExpiry: await verifyAuthExpiry(browser),
}));

console.log(JSON.stringify({ ok: true, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: "dark" | "light") {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  installDiagnostics(page, theme);
  await prepareBasePage(page, theme);

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    const taskCard = page.getByTestId("v3-task-alpha");
    await taskCard.waitFor({ state: "visible" });
    await assertRoundedFocus(page, taskCard, taskCard);
    await capture(page, theme, "01-task-card-focus");

    await taskCard.click();
    const sessionRow = page.locator(".v3-run-open").first();
    await sessionRow.waitFor({ state: "visible" });
    await assertRoundedFocus(page, sessionRow, sessionRow);
    await capture(page, theme, "02-session-row-focus");

    await sessionRow.click();
    const chatTextarea = page.getByTestId("chat-input").locator("textarea");
    const chatComposer = page.locator('[data-slot="chat-input-composer"]');
    await chatTextarea.waitFor({ state: "visible" });
    await assertRoundedFocus(page, chatTextarea, chatComposer);
    await capture(page, theme, "03-chat-composer-focus");

    await page.keyboard.press("Escape");
    await taskCard.click();
    await page.getByRole("button", { name: "새 세션", exact: true }).click();
    const modalSelect = page.getByRole("combobox", { name: "이어받을 이전 세션" });
    await modalSelect.waitFor({ state: "visible" });
    await assertRoundedFocus(page, modalSelect, modalSelect);
    await capture(page, theme, "04-modal-control-focus");
    await page.getByRole("button", { name: "승계 닫기" }).click();

    return {
      taskCardFocus: true,
      sessionRowFocus: true,
      chatComposerFocus: true,
      modalControlFocus: true,
    };
  } catch (error) {
    await captureDiagnostic(page, theme);
    throw error;
  } finally {
    await context.close();
  }
}

async function verifyAuthExpiry(browser: Browser) {
  const context = await browser.newContext({
    colorScheme: "dark",
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  let expired = false;
  installDiagnostics(page, "auth-expiry");
  await prepareBasePage(page, "dark");
  await page.route("**/api/auth/config", (route) => fulfillJson(route, {
    authEnabled: true,
    devModeEnabled: false,
  }));
  await page.route("**/api/auth/status", async (route) => {
    if (expired) await new Promise((resolve) => setTimeout(resolve, 600));
    await fulfillJson(route, expired
      ? { authenticated: false, user: null }
      : { authenticated: true, user: { email: "director@example.com", name: "Director" } });
  });
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    expired = true;
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Dashboard user is required" }),
    });
  });

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-alpha").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "새 업무", exact: true }).click();
    await page.getByRole("textbox", { name: "새 업무 제목" }).fill("만료 안내 QA");
    await page.getByRole("button", { name: "업무 만들기" }).click();
    await page.getByText(authExpiredMessage, { exact: true }).waitFor({ state: "visible" });
    await capture(page, "auth-expiry", "05-auth-expired-notice");
    await page.getByTestId("login-page").waitFor({ state: "visible" });
    return { toast: true, existingLoginFlow: true };
  } catch (error) {
    await captureDiagnostic(page, "auth-expiry");
    throw error;
  } finally {
    await context.close();
  }
}

async function prepareBasePage(page: Page, theme: "dark" | "light") {
  await page.addInitScript({ content: `
    localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
    localStorage.setItem("ls.webglGlass", "0");
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        configurable: true,
        value: async () => ({
          update: async () => undefined,
          active: null,
          installing: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }),
      });
      Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
    }
  ` });
  await installV3VisualQaRoutes(page);
}

async function assertRoundedFocus(page: Page, target: Locator, ringOwner: Locator) {
  await page.keyboard.press("Tab");
  await target.focus();
  const targetMetrics = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
    };
  });
  const ownerMetrics = await ringOwner.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderRadius: Number.parseFloat(style.borderTopLeftRadius),
      boxShadow: style.boxShadow,
    };
  });
  assert(targetMetrics.focusVisible, "키보드 focus-visible 상태가 아닙니다.");
  assert(targetMetrics.outlineStyle === "none", `사각 outline이 남았습니다: ${targetMetrics.outlineStyle}`);
  assert(ownerMetrics.borderRadius > 0, `링 소유자 radius가 없습니다: ${ownerMetrics.borderRadius}`);
  assert(ownerMetrics.boxShadow !== "none", "둥근 focus ring box-shadow가 없습니다.");
}

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, `${name}.png`),
    animations: "disabled",
    fullPage: true,
  });
}

async function captureDiagnostic(page: Page, label: string) {
  const bodyText = await page.locator("body").innerText().catch(() => "<body unavailable>");
  console.error(`[${label}] URL=${page.url()}\n${bodyText.slice(0, 4_000)}`);
  await capture(page, label, "99-failure-diagnostic").catch(() => undefined);
}

function installDiagnostics(page: Page, label: string) {
  page.on("pageerror", (error) => console.error(`[${label}] pageerror`, error));
  page.on("requestfailed", (request) => {
    console.error(`[${label}] requestfailed`, request.method(), request.url(), request.failure()?.errorText);
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

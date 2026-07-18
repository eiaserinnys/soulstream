import type { Browser, Page, Route } from "@playwright/test";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";

const result = await runPlaywrightLifecycle({
  lockName: "pr-bq-v3-main-promotion",
  timeoutMs: 240_000,
}, async ({ browser }) => ({
  dark: {
    desktop: await verifyEntryContract(browser, "dark", false),
    standaloneMobile: await verifyEntryContract(browser, "dark", true),
  },
  light: {
    desktop: await verifyEntryContract(browser, "light", false),
    standaloneMobile: await verifyEntryContract(browser, "light", true),
  },
  loginRoundTrips: await verifyLoginRoundTrips(browser),
}));

console.log(JSON.stringify({ ok: true, residualProcesses: 0, ...result }, null, 2));

async function verifyEntryContract(
  browser: Browser,
  theme: "dark" | "light",
  standaloneMobile: boolean,
) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    viewport: standaloneMobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 1000 },
    isMobile: standaloneMobile,
    hasTouch: standaloneMobile,
  });
  const page = await context.newPage();
  const errors = collectBrowserErrors(page);
  await preparePage(page, theme, standaloneMobile);
  await installV3VisualQaRoutes(page);
  await installMainPromotionRoutes(page);

  try {
    await openV3(page, "/");
    assert(await page.evaluate(() => document.documentElement.classList.contains("dark")) === (theme === "dark"), `${theme} 테마가 적용되지 않았습니다.`);
    if (standaloneMobile) {
      assert(await page.evaluate(() => matchMedia("(display-mode: standalone)").matches), "standalone 표시 모드가 적용되지 않았습니다.");
      await page.getByTestId("v3-mobile-tab-today").waitFor({ state: "visible" });
    }

    await page.getByRole("button", { name: "기존 대시보드 열기" }).click();
    await page.waitForURL(`${baseUrl}/v1`);
    if (standaloneMobile) {
      await page.getByRole("tab", { name: "설정" }).click();
    }
    await page.getByRole("button", { name: "v3 플래너 열기" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "v3 플래너 열기" }).click();
    await openV3(page, "/");

    await openV3(page, "/v3");
    await openV3(page, "/v2");

    assert(errors.length === 0, `브라우저 오류가 발생했습니다: ${errors.join(" | ")}`);
    return {
      mainRoute: "/",
      legacyRoute: "/v1",
      retiredRedirects: ["/v3", "/v2"],
      standaloneMobile,
      browserErrors: errors.length,
    };
  } finally {
    await context.close();
  }
}

async function verifyLoginRoundTrips(browser: Browser) {
  const results = [];
  for (const target of [
    { path: "/", expected: "v3" as const },
    { path: "/v1#/feed/run-alpha-1", expected: "v1" as const },
  ]) {
    const context = await browser.newContext({
      colorScheme: "dark",
      reducedMotion: "reduce",
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const errors = collectBrowserErrors(page);
    await preparePage(page, "dark", false);
    await installV3VisualQaRoutes(page);
    await installMainPromotionRoutes(page);
    let authenticated = false;
    let oauthReturnTo: string | null = null;
    await installAuthRoutes(
      page,
      () => authenticated,
      () => { authenticated = true; },
      (returnTo) => { oauthReturnTo = returnTo; },
    );

    try {
      await page.goto(`${baseUrl}${target.path}`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("login-page").waitFor({ state: "visible" });
      await page.getByTestId("google-login-button").click();
      assert(oauthReturnTo === target.path, `OAuth return_to가 ${oauthReturnTo ?? "없음"}입니다.`);

      if (target.expected === "v3") {
        await page.getByTestId("v3-task-alpha").waitFor({ state: "visible", timeout: 20_000 });
        assert(new URL(page.url()).pathname === "/", `로그인 뒤 v3 경로가 ${page.url()}입니다.`);
      } else {
        await page.getByRole("button", { name: "v3 플래너 열기" }).waitFor({ state: "visible", timeout: 20_000 });
        const url = new URL(page.url());
        assert(url.pathname === "/v1", `로그인 뒤 v1 경로가 ${page.url()}입니다.`);
      }
      assert(errors.length === 0, `로그인 왕복 브라우저 오류: ${errors.join(" | ")}`);
      results.push({ target: target.path, rendered: target.expected, browserErrors: errors.length });
    } finally {
      await context.close();
    }
  }
  return results;
}

async function openV3(page: Page, path: string) {
  await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(`${baseUrl}/`);
  try {
    await page.getByTestId("v3-task-alpha").waitFor({ state: "visible", timeout: 20_000 });
  } catch (error) {
    const body = (await page.content()).slice(0, 2_000);
    throw new Error(`v3 main did not render at ${page.url()}: ${body}`, { cause: error });
  }
}

async function installAuthRoutes(
  page: Page,
  isAuthenticated: () => boolean,
  authenticate: () => void,
  recordReturnTo: (returnTo: string) => void,
) {
  await page.route("**/api/auth/config", (route) => fulfillJson(route, {
    authEnabled: true,
    devModeEnabled: true,
  }));
  await page.route("**/api/auth/status", (route) => fulfillJson(route, {
    authenticated: isAuthenticated(),
    user: isAuthenticated()
      ? { email: "qa@example.test", name: "QA" }
      : null,
  }));
  await page.route("**/api/auth/dev-login", (route) => {
    authenticate();
    return fulfillJson(route, { ok: true });
  });
  await page.route("**/api/auth/google*", (route) => {
    const returnTo = new URL(route.request().url()).searchParams.get("return_to") ?? "/";
    recordReturnTo(returnTo);
    authenticate();
    return route.fulfill({ status: 302, headers: { location: returnTo } });
  });
}

async function installMainPromotionRoutes(page: Page) {
  await page.route("**/api/tasks/my-turn", (route) => fulfillJson(route, {
    my_turn_items: [],
    tasks: [],
  }));
}

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function preparePage(
  page: Page,
  theme: "dark" | "light",
  standalone: boolean,
) {
  await page.addInitScript({ content: `
    localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
    localStorage.setItem("ls.webglGlass", "0");
    const originalMatchMedia = window.matchMedia.bind(window);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query) => {
        if (query !== "(display-mode: standalone)") return originalMatchMedia(query);
        return {
          matches: ${JSON.stringify(standalone)},
          media: query,
          onchange: null,
          addListener: () => undefined,
          removeListener: () => undefined,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          dispatchEvent: () => true,
        };
      },
    });
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
      Object.defineProperty(serviceWorker, "controller", {
        configurable: true,
        get: () => null,
      });
    }
  ` });
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

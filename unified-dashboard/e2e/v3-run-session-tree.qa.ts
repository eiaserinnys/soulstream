import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_AX_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-run-session-tree"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-ax-v3-run-session-tree",
  timeoutMs: 180_000,
}, async ({ browser }) => ({
  dark: await verifyTheme(browser, "dark"),
  light: await verifyTheme(browser, "light"),
}));

console.log(JSON.stringify({ ok: true, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: "dark" | "light") {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await preparePage(page, theme);

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("v3-task-task-alpha").click();
    await page.locator(".v3-runs").waitFor({ state: "visible" });

    const runList = page.locator(".v3-runs .v3-run-list");
    const parent = runList.locator('[data-session-id="run-alpha-2"]');
    const child = runList.locator('[data-session-id="run-alpha-child"]');
    await parent.waitFor({ state: "visible" });
    await child.waitFor({ state: "visible" });

    const rootIds = await runList.locator(":scope > div > .v3-run-row")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-session-id")));
    assert(
      JSON.stringify(rootIds) === JSON.stringify(["run-alpha-2", "run-alpha-1"]),
      `루트 run 순서가 잘못되었습니다: ${JSON.stringify(rootIds)}`,
    );
    assert(await parent.getByText("세션 #2", { exact: true }).count() === 1, "최신 루트 run 번호가 #2가 아닙니다.");
    assert(await child.locator(".v3-run-number").count() === 0, "피위임 세션에 독립 run 번호가 표시됩니다.");

    const parentBox = await parent.boundingBox();
    const childBox = await child.boundingBox();
    assert(parentBox !== null && childBox !== null, "위임 트리 위치를 측정할 수 없습니다.");
    assert(childBox.x > parentBox.x, "피위임 세션이 부모보다 들여쓰기되지 않았습니다.");
    assert(
      await child.evaluate((element) => element.parentElement?.classList.contains("v3-run-children") === true),
      "피위임 세션이 트리 children 컨테이너에 렌더되지 않았습니다.",
    );
    assert(browserErrors.length === 0, `브라우저 오류가 발생했습니다: ${browserErrors.join(" | ")}`);

    await capture(page, theme);
    return {
      rootIds,
      parentRunNumber: 2,
      childIndentedPx: Math.round(childBox.x - parentBox.x),
      browserErrors: browserErrors.length,
    };
  } finally {
    await context.close();
  }
}

async function preparePage(page: Page, theme: "dark" | "light") {
  await page.addInitScript({ content: `
    localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
    localStorage.setItem("ls.webglGlass", "0");
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        configurable: true,
        value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
      });
      Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
    }
  ` });
  await installV3VisualQaRoutes(page);
  await page.route("**/api/planner/tasks/task-alpha/runs*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          { agent_session_id: "run-alpha-child" },
          { agent_session_id: "run-alpha-2" },
          { agent_session_id: "run-alpha-1" },
        ],
        next_cursor: null,
        total: 3,
      }),
    });
  });
}

async function capture(page: Page, theme: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, "01-delegation-tree.png"),
    animations: "disabled",
    fullPage: true,
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

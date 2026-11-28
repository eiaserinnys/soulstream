import { koreanLocale } from "./korean-locale.mjs";
import { expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { openV3Folder } from "./v3-qa-entry";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_BJ_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-icon-action-caps"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-bj-v3-icon-action-caps",
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
    locale: koreanLocale,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await preparePage(page, theme);

  try {
    await openV3Folder(page, baseUrl);
    await expect(page.getByRole("button", { name: "새 문서" })).toHaveCount(0);
    const projectCaps = await auditVisibleCaps(page);
    for (const label of ["전체 카드로 돌아가기"]) {
      assert(projectCaps.some((cap) => cap.label === label), `${label} 아이콘 캡이 없습니다.`);
    }
    await capture(page, theme, "02-project-actions");

    await page.getByTestId("v3-task-task-alpha").click();
    const detail = page.locator(".v3-detail-pane").first();
    await detail.getByTestId("v3-folder-cards-section").waitFor({ state: "visible" });
    await detail.getByTestId("v3-inline-board").waitFor({ state: "visible" });
    await detail.getByRole("button", { name: "새 세션" }).waitFor({ state: "visible" });

    // 세션 히스토리 캡은 실행 기록 자동 적재 중 잠시 크기가 0이 된다. 그 순간을
    // 재면 캡이 사라진 것으로 보이므로, 필수 캡이 다 보일 때까지 다시 잰다.
    const requiredDetailCaps = ["상위 폴더로 이동", "폴더 설명 편집", "마크다운 추가", "새 세션"];
    let detailCaps = await auditVisibleCaps(detail);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (requiredDetailCaps.every((label) => detailCaps.some((cap) => cap.label === label))) break;
      try {
        await detail.getByRole("button", { name: "새 세션" }).waitFor({ state: "visible", timeout: 15_000 });
      } catch {
        break;
      }
      detailCaps = await auditVisibleCaps(detail);
    }
    for (const label of requiredDetailCaps) {
      assert(
        detailCaps.some((cap) => cap.label === label),
        `${label} 아이콘 캡이 없습니다. 보이는 캡: ${detailCaps.map((cap) => cap.label).join(" | ")}`,
      );
    }
    assert(detailCaps.some((cap) => cap.label.startsWith("별표 ")), "별표 아이콘 캡이 없습니다.");
    assert(detailCaps.some((cap) => cap.label.startsWith("오늘 플래너")), "오늘 토글 아이콘 캡이 없습니다.");
    await assertPressedToggle(detail.locator('button[aria-label^="별표 "]'));
    await assertPressedToggle(detail.locator('button[aria-label^="오늘 플래너"][aria-pressed]'));

    const detailText = await detail.innerText();
    for (const removed of ["☆ 별표하기", "★ 별표됨", "＋ 마크다운", "＋ 새 세션", "이름 수정"]) {
      assert(!detailText.includes(removed), `텍스트 액션이 남았습니다: ${removed}`);
    }
    await capture(page, theme, "03-task-detail-actions");

    assert(errors.length === 0, `브라우저 오류가 발생했습니다: ${errors.join(" | ")}`);
    return {
      projectCaps: projectCaps.length,
      detailCaps: detailCaps.length,
      allCapsHaveLabelsAndTooltips: true,
      allCapsMatchSizePolicy: true,
      pressedStatesPreserved: true,
      browserErrors: errors.length,
    };
  } finally {
    await context.close();
  }
}

async function auditVisibleCaps(root: Page | ReturnType<Page["locator"]>) {
  const caps = root.locator('[data-slot="dashboard-icon-cap"]:visible');
  const count = await caps.count();
  return Promise.all(Array.from({ length: count }, async (_, index) => {
    const cap = caps.nth(index);
    const data = await cap.evaluate((element) => {
      const style = getComputedStyle(element);
      const compact = element.classList.contains("v3-planner-head-action");
      const pill = element.classList.contains("v3-context-add");
      const small = element.classList.contains("dashboard-icon-cap--small");
      return {
        label: element.getAttribute("aria-label") ?? "",
        tooltip: element.getAttribute("title") ?? "",
        compact,
        pill,
        small,
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        radius: style.borderRadius,
      };
    });
    assert(data.label.length > 0, `aria-label 없는 아이콘 캡 #${index}`);
    assert(data.tooltip.length > 0, `툴팁 없는 아이콘 캡: ${data.label}`);
    const size = data.compact || data.pill ? 28 : data.small ? 32 : 44;
    if (data.pill) assert(data.width >= size, `${data.label} 너비가 ${data.width}px입니다.`);
    else assert(Math.abs(data.width - size) < 0.2, `${data.label} 너비가 ${data.width}px입니다.`);
    assert(Math.abs(data.height - size) < 0.2, `${data.label} 높이가 ${data.height}px입니다.`);
    assert(Number.parseFloat(data.radius) >= size / 2, `${data.label} 라운딩이 ${data.radius}입니다.`);
    return data;
  }));
}

async function assertPressedToggle(locator: ReturnType<Page["locator"]>) {
  assert(await locator.count() === 1, "토글 액션을 하나로 특정하지 못했습니다.");
  const pressed = await locator.getAttribute("aria-pressed");
  assert(pressed === "true" || pressed === "false", "토글 액션의 aria-pressed가 없습니다.");
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
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: true });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

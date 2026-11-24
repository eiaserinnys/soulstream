#!/usr/bin/env node
// PAS 보고 시안의 요청된 장면과 조작 기록을 같은 빌드에서 생성한다.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist-mockups/pas-report-1707-thread");
const output = process.env.PAS_RT1707_CAPTURE_DIR ?? resolve(root, ".local/artifacts/pas-report-1707-thread");
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
  const file = join(dist, path === "/" ? "index.html" : path);
  if (!file.startsWith(dist) || !existsSync(file)) { response.writeHead(404); response.end("not found"); return; }
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
  response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
  response.end(await readFile(file));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const item = (page, number) => page.locator(".pas-rt1707-rail-item").filter({ hasText: `#${number}` });
const measure = (page) => page.evaluate(() => {
  const dialog = document.querySelector('[data-testid="pas-report-thread-dialog"]');
  const rail = document.querySelector(".pas-rt1707-rail");
  const thread = document.querySelector(".pas-rt1707-thread");
  const scroll = document.querySelector(".pas-rt1707-thread-scroll");
  const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  return { dialog: rect(dialog), rail: rect(rail), thread: rect(thread), scroll: rect(scroll),
    remaining: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
    overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth };
});
const values = {};
try {
  await runPlaywrightLifecycle({ lockName: "pas-report-1707-capture", timeoutMs: 540000, launchBrowser: (options) => chromium.launch(options) }, async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", deviceScaleFactor: 2, reducedMotion: "reduce" });
    await page.goto(`${base}/frame.html?theme=dark#report`, { waitUntil: "networkidle" });
    await page.getByTestId("pas-report-thread-dialog").waitFor();
    await wait(600);
    values.initialFocus = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    await item(page, 1512).click();
    await page.getByTestId("pas-rt1707-snooze-trigger").click();
    await page.getByRole("button", { name: "오늘 저녁", exact: true }).click();
    await item(page, 1680).click();
    await wait(500);
    assert((await page.locator('section[aria-label="미뤄 둠"]').innerText()).includes("#1512"), "미뤄 둠 구역이 없다");
    values.wide = await measure(page);
    assert(values.wide.remaining <= 4 && values.wide.overflow === 0, "넓은 화면 스크롤 또는 넘침이 다르다");
    if (process.env.PAS_RT1707_REUSE_REPORT !== "1") {
      await page.screenshot({ path: join(output, "1440x900-dark-report.png"), timeout: 120000 });
    }

    await page.getByTestId("pas-rt1707-open-card-panel").click();
    const panel = page.getByTestId("v3-card-workspace");
    await panel.waitFor({ state: "visible" });
    values.panelFocus = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    values.panelHit = await panel.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return Boolean(document.elementFromPoint(r.left + r.width * .75, r.top + r.height * .25)?.closest('[data-testid="v3-card-workspace"]'));
    });
    assert(values.panelHit, "카드 패널이 가려졌다");
    await page.screenshot({ path: join(output, "1440x900-dark-card-workspace.png"), timeout: 120000 });
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    await wait(100);
    values.panelReturn = await page.getByTestId("pas-rt1707-open-card-panel").evaluate((el) => el === document.activeElement);
    assert(values.panelReturn, "카드 패널을 닫고 초점이 돌아오지 않았다");

    await item(page, 1730).click();
    const scroll = page.locator(".pas-rt1707-thread-scroll");
    await scroll.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
    await wait(300);
    const jump = page.getByTestId("pas-rt1707-jump-latest");
    await jump.waitFor({ state: "visible" });
    values.pill = await jump.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent.trim(), position: getComputedStyle(el).position, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    assert(values.pill.position === "absolute", "최신 경과 단추가 본문에 겹치지 않는다");
    await page.screenshot({ path: join(output, "1440x900-dark-autoscroll-pill.png"), timeout: 120000 });
    await jump.click();
    values.jumpRemaining = await scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    assert(values.jumpRemaining <= 4, "최신 경과로 돌아가지 않았다");

    const input = page.locator(".pas-rt1707-decide-input textarea");
    await input.fill("크기 변경 확인");
    await page.setViewportSize({ width: 390, height: 844 });
    await wait(500);
    values.resizeText = await input.inputValue();
    assert(values.resizeText === "크기 변경 확인", "크기 변경 중 입력이 사라졌다");
    await page.getByTestId("pas-rt1707-rail-toggle").click();
    await page.locator(".pas-rt1707-rail").waitFor({ state: "visible" });
    values.narrow = await measure(page);
    values.rows = await page.locator(".pas-rt1707-rail-item").evaluateAll((els) => els.slice(0, 2).map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, title: el.querySelector(".pas-rt1707-rail-title")?.textContent };
    }));
    assert(values.narrow.overflow === 0 && values.rows[1].top >= values.rows[0].bottom - 1, "좁은 화면의 세로 목록 또는 넘침이 다르다");
    await page.screenshot({ path: join(output, "390x844-dark-mobile-drawer.png"), timeout: 120000 });
    await page.keyboard.press("Escape");
    values.drawerClosed = !(await page.locator(".pas-rt1707-rail").isVisible());
    values.drawerReturn = await page.getByTestId("pas-rt1707-rail-toggle").evaluate((el) => el === document.activeElement);
    assert(values.drawerClosed && values.drawerReturn, "서랍 닫기 또는 초점 복귀가 실패했다");
    await page.close();
  });

  const rows = [
    "# PAS 보고 시안 조작 결과",
    "",
    "## 정적 대조",
    "",
    "| 항목 | 측정과 판정 |",
    "| --- | --- |",
    `| 넓은 화면 | 레일과 스레드 위쪽 차이 ${Math.abs(values.wide.rail.top - values.wide.thread.top).toFixed(2)}px, 가로 넘침 ${values.wide.overflow}px, 최신 경과 거리 ${values.wide.remaining}px |`,
    `| 좁은 화면 | 가로 넘침 ${values.narrow.overflow}px, 첫 두 행 ${values.rows[0].top.toFixed(2)}부터 ${values.rows[0].bottom.toFixed(2)} 및 ${values.rows[1].top.toFixed(2)}부터 ${values.rows[1].bottom.toFixed(2)}px |`,
    `| 최신 경과 단추 | ${values.pill.position}, ${values.pill.text}, 왼쪽 ${values.pill.left.toFixed(2)}px, 위 ${values.pill.top.toFixed(2)}px |`,
    "",
    "## 조작 시나리오 측정",
    "",
    "| 항목 | 결과 | 근거 |",
    "| --- | --- | --- |",
    `| 14 초점 | 통과 | 카드 패널 첫 초점 ${values.panelFocus}, Escape 뒤 열기 단추 복귀 ${values.panelReturn} |`,
    `| 15 Tab과 Escape | 일부 확인 | 카드 패널과 서랍 Escape 및 초점 복귀 ${values.drawerReturn}, Tab 순서는 이 스크립트에서 미측정 |`,
    `| 16 최소 폭 | 일부 확인 | 390px 세로 행과 가로 넘침 ${values.narrow.overflow}px, 360px 미측정 |`,
    "| 17 오류 상태 | 미측정 | 문서 실패 응답 조작은 이번 캡처에서 실행하지 않았다 |",
    `| 18 창 크기 변경 | 일부 확인 | 1440에서 390으로 바꾼 뒤 입력 유지 ${values.resizeText === "크기 변경 확인"}, 스크롤 위치 미측정 |`,
    "",
    "## 대화상자와 줄 안 편집",
    "",
    "| 대상 | 여는 법 | 첫 초점 | Enter | Escape | 닫은 뒤 초점 |",
    "| --- | --- | --- | --- | --- | --- |",
    `| 보고 창 | 주소와 말풍선 | ${values.initialFocus} | 미측정 | QA에서 확인 | 보고 창 열기 단추 |`,
    `| 카드 패널 | 카드 패널 열기 | ${values.panelFocus} | 미측정 | 통과 | 열기 단추 복귀 ${values.panelReturn} |`,
    `| 안건 서랍 | 안건 목록 | 미측정 | 미측정 | 통과 | 목록 단추 복귀 ${values.drawerReturn} |`,
    "| 미루기 선택 | 답변 미루기 | 미측정 | 미측정 | 미측정 | 미측정 |",
    "",
    "실행: node unified-dashboard/e2e/pas-report-1707-capture.mjs",
    `산출물: ${output}`,
  ];
  await writeFile(join(output, "operations.md"), rows.join("\n") + "\n");
  await writeFile(join(output, "capture-metrics.json"), JSON.stringify(values, null, 2) + "\n");
  console.log(JSON.stringify(values, null, 2));
} finally {
  await new Promise((done) => server.close(done));
}

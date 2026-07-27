import type { Browser, Locator } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.ASKQUESTION_INPUT_ROW_QA_OUTPUT
    ?? path.join("e2e", "screenshots", "v3-askquestion-input-row"),
);

const result = await runPlaywrightLifecycle({
  lockName: "v3-askquestion-input-row",
  timeoutMs: 120_000,
}, async ({ browser }) => verifyInputRows(browser));

console.log(JSON.stringify({ ok: true, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyInputRows(browser: Browser) {
  const context = await browser.newContext({
    colorScheme: "dark",
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await page.goto(
      `${baseUrl}/e2e/v3-askquestion-input-row.fixture.html?surface=banner`,
      { waitUntil: "domcontentloaded" },
    );
    const banner = page.getByTestId("ask-question-banner");
    await banner.waitFor({ state: "visible", timeout: 20_000 });
    const bannerInput = banner.locator('input[placeholder="직접 입력"]');
    await bannerInput.focus();
    const bannerMetrics = await measureWidget(banner);
    assertInputRow("banner-wide", bannerMetrics);
    await capture(banner, "01-banner-wide");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `${baseUrl}/e2e/v3-askquestion-input-row.fixture.html?surface=chat`,
      { waitUntil: "domcontentloaded" },
    );
    const chatWidget = page
      .locator('[data-tree-node-id]')
      .filter({ has: page.locator('input[placeholder="직접 입력"]') })
      .last();
    await chatWidget.waitFor({ state: "visible", timeout: 20_000 });
    const chatMetrics = await measureWidget(chatWidget);
    assertInputRow("chat-narrow", chatMetrics);
    await capture(chatWidget, "02-chat-narrow");

    assert(browserErrors.length === 0, `브라우저 오류가 발생했습니다: ${browserErrors.join(" | ")}`);
    const metrics = {
      bannerWide: bannerMetrics,
      chatNarrow: chatMetrics,
      browserErrors,
    };
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(path.join(outputRoot, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
    return metrics;
  } finally {
    await context.close();
  }
}

async function measureWidget(widget: Locator) {
  const metrics = await widget.evaluate((element) => {
    const input = element.querySelector<HTMLInputElement>('input[placeholder="직접 입력"]');
    const submit = Array.from(element.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "전송");
    const form = input?.closest("form");
    const options = Array.from(
      element.querySelectorAll<HTMLElement>('[data-testid="input-request-option-content"]'),
    ).map((content) => content.closest<HTMLButtonElement>("button")).filter(
      (button): button is HTMLButtonElement => button !== null,
    );
    if (!input || !submit || !form) return null;

    const inputRect = input.getBoundingClientRect();
    const submitRect = submit.getBoundingClientRect();
    const formStyle = getComputedStyle(form);
    const inputStyle = getComputedStyle(input);
    const submitStyle = getComputedStyle(submit);
    const optionRects = options.map((option) => option.getBoundingClientRect());
    const formRect = form.getBoundingClientRect();
    return {
      widget: {
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
      },
      formGap: Number.parseFloat(formStyle.columnGap),
      input: {
        height: inputRect.height,
        top: inputRect.top,
        bottom: inputRect.bottom,
        radius: inputStyle.borderTopLeftRadius,
        paddingLeft: inputStyle.paddingLeft,
        paddingRight: inputStyle.paddingRight,
      },
      submit: {
        height: submitRect.height,
        top: submitRect.top,
        bottom: submitRect.bottom,
        radius: submitStyle.borderTopLeftRadius,
        paddingLeft: submitStyle.paddingLeft,
        paddingRight: submitStyle.paddingRight,
        className: submit.className,
      },
      optionCount: options.length,
      optionFits: options.map((option) => option.scrollHeight <= option.clientHeight),
      optionGaps: optionRects.slice(1).map((rect, index) => rect.top - optionRects[index]!.bottom),
      inputRowGap: optionRects.length === 0
        ? null
        : formRect.top - optionRects[optionRects.length - 1]!.bottom,
    };
  });
  assert(metrics !== null, "입력 행 측정 대상을 찾지 못했습니다.");
  return metrics;
}

function assertInputRow(name: string, metrics: Awaited<ReturnType<typeof measureWidget>>) {
  assert(Math.abs(metrics.input.height - metrics.submit.height) <= 1, `${name}: 높이 ${metrics.input.height}/${metrics.submit.height}`);
  assert(Math.abs(metrics.input.top - metrics.submit.top) <= 1, `${name}: 상단 정렬 ${metrics.input.top}/${metrics.submit.top}`);
  assert(Math.abs(metrics.input.bottom - metrics.submit.bottom) <= 1, `${name}: 하단 정렬 ${metrics.input.bottom}/${metrics.submit.bottom}`);
  assert(metrics.input.radius === metrics.submit.radius, `${name}: 반경 ${metrics.input.radius}/${metrics.submit.radius}`);
  assert(metrics.input.paddingLeft === metrics.submit.paddingLeft, `${name}: 좌측 여백 ${metrics.input.paddingLeft}/${metrics.submit.paddingLeft}`);
  assert(metrics.input.paddingRight === metrics.submit.paddingRight, `${name}: 우측 여백 ${metrics.input.paddingRight}/${metrics.submit.paddingRight}`);
  assert(Math.abs(metrics.formGap - 8) <= 0.5, `${name}: form gap ${metrics.formGap}`);
  assert(metrics.optionCount === 3, `${name}: 선택지 수 ${metrics.optionCount}`);
  assert(metrics.optionFits.every(Boolean), `${name}: 선택지 내용이 행을 벗어났습니다.`);
  assert(metrics.optionGaps.every((gap) => gap >= 7.5), `${name}: 선택지 간격 ${metrics.optionGaps.join(",")}`);
  assert((metrics.inputRowGap ?? 0) >= 7.5, `${name}: 선택지→입력 행 간격 ${metrics.inputRowGap}`);
  assert(!metrics.submit.className.includes("sm:h-6"), `${name}: sm:h-6이 남았습니다.`);
  assert(!metrics.submit.className.includes("rounded-full"), `${name}: rounded-full이 남았습니다.`);
}

async function capture(widget: Locator, name: string) {
  mkdirSync(outputRoot, { recursive: true });
  await widget.scrollIntoViewIfNeeded();
  await widget.screenshot({
    path: path.join(outputRoot, `${name}.png`),
    animations: "disabled",
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

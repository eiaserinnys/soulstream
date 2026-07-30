import type { Browser, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.TURN_SUMMARY_QA_OUTPUT
    ?? path.join(".local", "artifacts", "screenshots", "turn-summary-caption"),
);
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
if (!chromiumExecutable) throw new Error("PLAYWRIGHT_CHROMIUM_EXECUTABLE is required");

const result = await runPlaywrightLifecycle({
  lockName: "turn-summary-caption",
  timeoutMs: 120_000,
  launchOptions: {
    headless: true,
    executablePath: chromiumExecutable,
  },
}, async ({ browser }) => verifyTurnSummaryCaption(browser));

console.log(JSON.stringify({ ok: true, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyTurnSummaryCaption(browser: Browser) {
  const context = await browser.newContext({
    colorScheme: "dark",
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1180, height: 900 },
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await page.addInitScript({ content: `
      Object.defineProperty(globalThis, "__name", { configurable: true, value: (target) => target });
      localStorage.setItem("soul-dashboard-theme", "dark");
      localStorage.setItem("ls.webglGlass", "0");
      if (navigator.serviceWorker) {
        Object.defineProperty(navigator.serviceWorker, "register", {
          configurable: true,
          value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
        });
        Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
      }
    ` });
    await installV3VisualQaRoutes(page);
    await openChat(page);
    await injectLateSummary(page);

    const chatPane = page.locator(".v3-chat-pane");
    const summary = page.locator('[data-tree-node-id="turn-summary-140"]');
    await summary.waitFor({ state: "visible", timeout: 20_000 });
    const metrics = await measureTimeline(page);

    assert(
      metrics.order.join(",") === "asst-msg-119,complete-120,turn-summary-140,user-msg-130",
      `캡션 순서가 잘못됐습니다: ${metrics.order.join(",")}`,
    );
    assert(metrics.summary.fontSize === metrics.complete.fontSize, "기존 complete 캡션의 글자 크기를 재사용하지 않았습니다.");
    assert(metrics.summary.color !== metrics.complete.color, "완료 성공 톤과 요약 보조 톤의 기존 구분이 사라졌습니다.");
    assert(metrics.summary.textAlign === "left", "다줄 요약 캡션이 좌측 정렬되지 않았습니다.");
    assert(metrics.complete.textAlign === "left", "한 줄 완료 캡션이 좌측 정렬되지 않았습니다.");
    assert(metrics.summary.whiteSpace === "pre-line", "요약 줄바꿈이 보존되지 않았습니다.");
    assert(metrics.completeText.includes("이번 턴 $0.1400"), "Turn Complete에 계산된 비용 차분이 보이지 않습니다.");
    assert(metrics.completeText.includes("누적 $35.1400"), "Turn Complete에 누적 비용이 보이지 않습니다.");
    assert(metrics.completeText.includes("2,846,290 in"), "Turn Complete에 캐시 포함 입력 토큰이 보이지 않습니다.");
    assert(!metrics.resultVisible, "Session Complete 캡션이 중복 표시됩니다.");
    assert(browserErrors.length === 0, `브라우저 오류: ${browserErrors.join(" | ")}`);

    mkdirSync(outputRoot, { recursive: true });
    await chatPane.screenshot({
      path: path.join(outputRoot, "chat-frame-dark.png"),
      animations: "disabled",
    });
    writeFileSync(
      path.join(outputRoot, "metrics.json"),
      `${JSON.stringify({ metrics, browserErrors }, null, 2)}\n`,
      "utf8",
    );
    return { metrics, browserErrors };
  } finally {
    await context.close();
  }
}

async function openChat(page: Page) {
  await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("v3-task-task-alpha").click();
  const run = page.locator(".v3-detail-pane .v3-run-open").filter({ hasText: "시각 QA 순회" });
  await run.waitFor({ state: "visible", timeout: 20_000 });
  await run.click();
  await page.locator('[data-slot="chat-root"]').waitFor({ state: "visible", timeout: 20_000 });
}

async function injectLateSummary(page: Page) {
  await page.evaluate(() => {
    const store = (globalThis as unknown as {
      __SOULSTREAM_STORE__: {
        getState(): {
          processEvent(event: Record<string, unknown>, eventId: number): unknown;
        };
      };
    }).__SOULSTREAM_STORE__;
    const processEvent = store.getState().processEvent;
    processEvent({
      type: "result",
      success: true,
      output: "직전 턴 완료",
      total_cost_usd: 35,
      timestamp: 110,
    }, 110);
    processEvent({ type: "assistant_message", content: "최종 구현과 검증 방향을 확정했습니다.", timestamp: 119 }, 119);
    processEvent({
      type: "complete",
      result: "Turn completed",
      attachments: [],
      usage: {
        input_tokens: 8,
        output_tokens: 5300,
        cache_read_input_tokens: 2_838_895,
        cache_creation_input_tokens: 7_387,
      },
      total_cost_usd: 35.14,
      timestamp: 120,
    }, 120);
    processEvent({
      type: "result",
      success: true,
      output: "현재 턴 완료",
      usage: {
        input_tokens: 8,
        output_tokens: 5300,
        cache_read_input_tokens: 2_838_895,
        cache_creation_input_tokens: 7_387,
      },
      total_cost_usd: 35.14,
      timestamp: 121,
    }, 121);
    processEvent({ type: "user_message", text: "그다음 턴에서 배포 순서를 확인해 주세요.", user: "디렉터님", timestamp: 130 }, 130);
    processEvent({
      type: "turn_summary",
      content: "웹 채팅은 턴 경계 투영으로 늦은 요약도 제자리에 둡니다.\n전체 목록을 다시 그리지 않고 기존 메시지 참조를 보존합니다.",
      final_response_event_id: 119,
      parent_event_id: 119,
      timestamp: 140,
    }, 140);
  });
}

async function measureTimeline(page: Page) {
  return page.evaluate(() => {
    const ids = ["asst-msg-119", "complete-120", "turn-summary-140", "user-msg-130"];
    const elements = ids.map((id) => document.querySelector<HTMLElement>(`[data-tree-node-id="${id}"]`));
    const order = Array.from(document.querySelectorAll<HTMLElement>("[data-tree-node-id]"))
      .map((element) => element.dataset.treeNodeId ?? "")
      .filter((id) => ids.includes(id));
    const summary = elements[2]?.querySelector<HTMLElement>(".flex-1");
    const complete = elements[1]?.querySelector<HTMLElement>(".flex-1");
    if (!summary || !complete) throw new Error("시스템 캡션 내부 요소를 찾지 못했습니다.");
    const summaryStyle = getComputedStyle(summary);
    const completeStyle = getComputedStyle(complete);
    return {
      order,
      summary: {
        fontSize: summaryStyle.fontSize,
        color: summaryStyle.color,
        textAlign: summaryStyle.textAlign,
        whiteSpace: summaryStyle.whiteSpace,
        width: summary.getBoundingClientRect().width,
      },
      complete: {
        fontSize: completeStyle.fontSize,
        color: completeStyle.color,
        textAlign: completeStyle.textAlign,
        whiteSpace: completeStyle.whiteSpace,
        width: complete.getBoundingClientRect().width,
      },
      completeText: elements[1]?.textContent ?? "",
      resultVisible: document.querySelector<HTMLElement>(
        '[data-tree-node-id="result-121"]',
      ) !== null,
      chatPane: document.querySelector<HTMLElement>(".v3-chat-pane")?.getBoundingClientRect().toJSON(),
    };
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

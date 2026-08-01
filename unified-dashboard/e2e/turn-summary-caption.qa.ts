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
      metrics.order.join(",") === "asst-msg-119,turn-summary-140,complete-120,user-msg-130",
      `캡션 순서가 잘못됐습니다: ${metrics.order.join(",")}`,
    );
    assert(metrics.summary.fontSize === metrics.complete.fontSize, "기존 complete 캡션의 글자 크기를 재사용하지 않았습니다.");
    assert(metrics.summary.color !== metrics.complete.color, "완료 성공 톤과 요약 보조 톤의 기존 구분이 사라졌습니다.");
    assert(metrics.summary.textAlign === "left", "다줄 요약 캡션이 좌측 정렬되지 않았습니다.");
    assert(metrics.complete.textAlign === "left", "한 줄 완료 캡션이 좌측 정렬되지 않았습니다.");
    assert(metrics.summary.whiteSpace === "pre-line", "요약 줄바꿈이 보존되지 않았습니다.");
    assert(metrics.complete.display === "flex", "턴 완료 라벨과 수치가 flex 한 줄로 배치되지 않았습니다.");
    assert(metrics.complete.flexWrap === "wrap", "좁은 폭에서 수치 블록을 줄바꿈할 수 없습니다.");
    assert(metrics.complete.labelText === "턴 완료", "턴 완료 라벨이 한국어로 표시되지 않았습니다.");
    assert(
      metrics.complete.statsText
        === "최근 $3.31 · 누적 $3.31 · 입력 2,985,241 (캐시 2,985,234) · 출력 1,473",
      `턴 완료 수치 포맷이 다릅니다: ${metrics.complete.statsText}`,
    );
    assert(
      Math.abs(
        metrics.complete.labelLeft
          - metrics.complete.containerLeft
          - metrics.complete.paddingLeft
      ) < 1,
      "턴 완료 라벨이 캡션 좌측에 붙지 않았습니다.",
    );
    assert(
      Math.abs(
        metrics.complete.containerRight
          - metrics.complete.paddingRight
          - metrics.complete.statsRight
      ) < 1,
      "턴 완료 수치 블록이 캡션 우측에 붙지 않았습니다.",
    );
    assert(metrics.complete.statsTextAlign === "right", "수치 블록 줄바꿈이 우측 기준이 아닙니다.");
    assert(!metrics.resultVisible, "Session Complete 캡션이 중복 표시됩니다.");
    assert(browserErrors.length === 0, `브라우저 오류: ${browserErrors.join(" | ")}`);

    mkdirSync(outputRoot, { recursive: true });
    await chatPane.screenshot({
      path: path.join(outputRoot, "chat-frame-dark.png"),
      animations: "disabled",
    });
    const scrollRetention = await verifyActualViewportRetention(page);
    writeFileSync(
      path.join(outputRoot, "metrics.json"),
      `${JSON.stringify({ metrics, scrollRetention, browserErrors }, null, 2)}\n`,
      "utf8",
    );
    return { metrics, scrollRetention, browserErrors };
  } finally {
    await context.close();
  }
}

async function verifyActualViewportRetention(page: Page) {
  await page.evaluate(() => {
    const store = (globalThis as unknown as {
      __SOULSTREAM_STORE__: {
        getState(): {
          processEvent(event: Record<string, unknown>, eventId: number): unknown;
        };
      };
    }).__SOULSTREAM_STORE__;
    for (let eventId = 1_000; eventId < 1_300; eventId++) {
      store.getState().processEvent({
        type: "assistant_message",
        content: `long timeline row ${eventId}\nviewport geometry contract`,
        timestamp: eventId,
      }, eventId);
    }
  });

  const scroller = page.locator('[data-chat-scroller="true"]');
  await scroller.waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(750);
  await scroller.evaluate((element) => {
    element.scrollTop = Math.floor(
      (element.scrollHeight - element.clientHeight) * 0.55,
    );
    element.dispatchEvent(new Event("scroll"));
  });
  await waitForSettledViewport(page);

  const before = await measureViewport(page);
  assert(
    before.observedFirstKey === before.firstKey,
    `제품 observer가 실제 first-visible key를 기록하지 못했습니다: ${JSON.stringify(before)}`,
  );
  assert(before.overscanAboveKeys.length > 0, "800px 위 overscan 행을 관찰하지 못했습니다.");
  assert(before.visibleKeys.length > 1, "실제 viewport 교차 행이 부족합니다.");
  const firstVisibleEventId = parseEventId(before.firstKey);
  const farBeforeKey = Array.from(
    { length: firstVisibleEventId - 1_000 },
    (_, index) => `asst-msg-${1_000 + index}`,
  ).find((key) => !before.renderedKeys.includes(key));
  assert(farBeforeKey !== undefined, "overscan 밖의 loaded far-before 행을 찾지 못했습니다.");

  await installScrollCommandProbe(page);
  await injectSummary(page, 9_001, parseEventId(farBeforeKey), "overscan 밖 visible 앞 삽입");
  await waitForSettledViewport(page);
  const afterFarBefore = await measureViewport(page);
  assertViewportPreserved(before, afterFarBefore, "overscan 밖 visible 앞");
  assert(
    Math.abs(afterFarBefore.retentionCorrectionPx) < 0.5,
    "렌더되지 않은 far-before 앵커에 불필요한 viewport 보정이 발생했습니다.",
  );

  const overscanAnchor = parseEventId(
    afterFarBefore.overscanAboveKeys[afterFarBefore.overscanAboveKeys.length - 1],
  );
  await injectSummary(page, 9_002, overscanAnchor, "overscan 안 visible 앞 삽입");
  await waitForSettledViewport(page);
  const afterOverscanBefore = await measureViewport(page);
  assertViewportPreserved(afterFarBefore, afterOverscanBefore, "overscan 안 visible 앞");
  assert(
    Math.abs(afterOverscanBefore.retentionCorrectionPx) >= 0.5,
    "overscan 행 높이 변화에 대한 실제 viewport offset 보정이 관찰되지 않았습니다.",
  );

  const afterVisibleAnchor = parseEventId(afterOverscanBefore.visibleKeys[1]);
  await injectSummary(page, 9_003, afterVisibleAnchor, "visible 뒤 삽입");
  await waitForSettledViewport(page);
  const afterVisible = await measureViewport(page);
  assertViewportPreserved(afterOverscanBefore, afterVisible, "visible 뒤");
  assert(
    Math.abs(afterVisible.retentionCorrectionPx) < 0.5,
    "first-visible 뒤 삽입에 불필요한 viewport 보정이 발생했습니다.",
  );

  const scrollCommands = await page.evaluate(() => (
    globalThis as unknown as { __TURN_SUMMARY_SCROLL_COMMANDS__: string[] }
  ).__TURN_SUMMARY_SCROLL_COMMANDS__);
  assert(scrollCommands.length === 0, `강제 scroll 명령이 발생했습니다: ${scrollCommands.join(",")}`);
  assert(
    afterVisible.distanceFromBottom > afterVisible.viewportHeight,
    "과거 읽기 중 대화 끝으로 강제 이동했습니다.",
  );

  return {
    increaseViewportBy: { top: 800, bottom: 400 },
    before,
    afterFarBefore,
    afterOverscanBefore,
    afterVisible,
    scrollCommands,
  };
}

async function waitForSettledViewport(page: Page) {
  await page.waitForFunction(() => {
    const scroller = document.querySelector<HTMLElement>('[data-chat-scroller="true"]');
    if (!scroller) return false;
    const viewport = scroller.getBoundingClientRect();
    const visible = Array.from(
      scroller.querySelectorAll<HTMLElement>("[data-chat-item-key]"),
    ).flatMap((marker) => {
      const key = marker.dataset.chatItemKey;
      const rows = Array.from(marker.children).filter(
        (row): row is HTMLElement => row instanceof HTMLElement,
      );
      if (!key || rows.length === 0) return [];
      const rects = rows.map((row) => row.getBoundingClientRect());
      const top = Math.min(...rects.map((row) => row.top));
      const bottom = Math.max(...rects.map((row) => row.bottom));
      return bottom > viewport.top && top < viewport.bottom ? [{ key, top }] : [];
    }).sort((left, right) => left.top - right.top);
    return visible.length > 0
      && scroller.dataset.chatFirstVisibleKey === visible[0]?.key;
  }, undefined, { timeout: 10_000 });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function installScrollCommandProbe(page: Page) {
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-chat-scroller="true"]');
    if (!scroller) throw new Error("chat scroller를 찾지 못했습니다.");
    const calls: string[] = [];
    const originalScrollTo = scroller.scrollTo.bind(scroller);
    const originalScrollBy = scroller.scrollBy.bind(scroller);
    scroller.scrollTo = (...args: Parameters<HTMLElement["scrollTo"]>) => {
      calls.push("scrollTo");
      originalScrollTo(...args);
    };
    scroller.scrollBy = (...args: Parameters<HTMLElement["scrollBy"]>) => {
      calls.push("scrollBy");
      originalScrollBy(...args);
    };
    (
      globalThis as unknown as { __TURN_SUMMARY_SCROLL_COMMANDS__: string[] }
    ).__TURN_SUMMARY_SCROLL_COMMANDS__ = calls;
  });
}

async function injectSummary(
  page: Page,
  summaryEventId: number,
  anchorEventId: number,
  content: string,
) {
  await page.evaluate(({ summaryEventId, anchorEventId, content }) => {
    const store = (globalThis as unknown as {
      __SOULSTREAM_STORE__: {
        getState(): {
          processEvent(event: Record<string, unknown>, eventId: number): unknown;
        };
      };
    }).__SOULSTREAM_STORE__;
    store.getState().processEvent({
      type: "turn_summary",
      content,
      final_response_event_id: anchorEventId,
      parent_event_id: anchorEventId,
      timestamp: summaryEventId,
    }, summaryEventId);
  }, { summaryEventId, anchorEventId, content });
}

interface ViewportMeasurement {
  firstItemIndex: number;
  observedFirstKey: string;
  firstKey: string;
  firstTop: number;
  visibleKeys: string[];
  overscanAboveKeys: string[];
  renderedKeys: string[];
  scrollTop: number;
  viewportHeight: number;
  distanceFromBottom: number;
  retentionCorrectionPx: number;
}

async function measureViewport(page: Page): Promise<ViewportMeasurement> {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-chat-scroller="true"]');
    if (!scroller) throw new Error("chat scroller를 찾지 못했습니다.");
    const viewport = scroller.getBoundingClientRect();
    const rows = Array.from(
      scroller.querySelectorAll<HTMLElement>("[data-chat-item-key]"),
    ).flatMap((marker) => {
      const key = marker.dataset.chatItemKey;
      const rows = Array.from(marker.children).filter(
        (row): row is HTMLElement => row instanceof HTMLElement,
      );
      if (rows.length === 0 || !key) return [];
      const rects = rows.map((row) => row.getBoundingClientRect());
      return [{
        key,
        rect: {
          top: Math.min(...rects.map((row) => row.top)),
          bottom: Math.max(...rects.map((row) => row.bottom)),
        },
      }];
    });
    const visible = rows
      .filter(({ rect }) => rect.bottom > viewport.top && rect.top < viewport.bottom)
      .sort((a, b) => a.rect.top - b.rect.top);
    const overscanAbove = rows
      .filter(({ rect }) => rect.bottom <= viewport.top)
      .sort((a, b) => a.rect.bottom - b.rect.bottom);
    const first = visible[0];
    if (!first) throw new Error("실제 viewport 교차 행을 찾지 못했습니다.");
    return {
      firstItemIndex: Number(
        document.querySelector<HTMLElement>('[data-slot="chat-root"]')
          ?.dataset.chatFirstItemIndex,
      ),
      observedFirstKey: scroller.dataset.chatFirstVisibleKey ?? "",
      firstKey: first.key,
      firstTop: first.rect.top - viewport.top,
      visibleKeys: visible.map(({ key }) => key),
      overscanAboveKeys: overscanAbove.map(({ key }) => key),
      renderedKeys: rows.map(({ key }) => key),
      scrollTop: scroller.scrollTop,
      viewportHeight: scroller.clientHeight,
      distanceFromBottom: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
      retentionCorrectionPx: Number(
        scroller.dataset.chatViewportRetentionCorrection ?? "0",
      ),
    };
  });
}

function assertViewportPreserved(
  before: ViewportMeasurement,
  after: ViewportMeasurement,
  label: string,
) {
  assert(
    after.firstKey === before.firstKey,
    `${label}: first-visible key가 바뀌었습니다. ${JSON.stringify({ before, after })}`,
  );
  assert(
    Math.abs(after.firstTop - before.firstTop) < 1,
    `${label}: first-visible offset이 ${before.firstTop} → ${after.firstTop}로 움직였습니다.`,
  );
}

function parseEventId(key: string): number {
  const match = key.match(/-(\d+)$/);
  const eventId = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(eventId) || eventId <= 0) {
    throw new Error(`event ID를 key에서 읽지 못했습니다: ${key}`);
  }
  return eventId;
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
        input_tokens: 7,
        output_tokens: 1473,
        cache_read_input_tokens: 2_985_000,
        cache_creation_input_tokens: 234,
      },
      total_cost_usd: 3.31,
      timestamp: 120,
    }, 120);
    processEvent({
      type: "result",
      success: true,
      output: "현재 턴 완료",
      usage: {
        input_tokens: 7,
        output_tokens: 1473,
        cache_read_input_tokens: 2_985_000,
        cache_creation_input_tokens: 234,
      },
      total_cost_usd: 3.31,
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
    const ids = ["asst-msg-119", "turn-summary-140", "complete-120", "user-msg-130"];
    const elements = ids.map((id) => document.querySelector<HTMLElement>(`[data-tree-node-id="${id}"]`));
    const order = Array.from(document.querySelectorAll<HTMLElement>("[data-tree-node-id]"))
      .map((element) => element.dataset.treeNodeId ?? "")
      .filter((id) => ids.includes(id));
    const summary = elements[1]?.querySelector<HTMLElement>(".flex-1");
    const complete = elements[2]?.querySelector<HTMLElement>(".flex-1");
    if (!summary || !complete) throw new Error("시스템 캡션 내부 요소를 찾지 못했습니다.");
    const completeLabel = complete.querySelector<HTMLElement>(
      '[data-slot="complete-caption-label"]',
    );
    const completeStats = complete.querySelector<HTMLElement>(
      '[data-slot="complete-caption-stats"]',
    );
    if (!completeLabel || !completeStats) {
      throw new Error("턴 완료 라벨·수치 블록을 찾지 못했습니다.");
    }
    const summaryStyle = getComputedStyle(summary);
    const completeStyle = getComputedStyle(complete);
    const statsStyle = getComputedStyle(completeStats);
    const completeRect = complete.getBoundingClientRect();
    const labelRect = completeLabel.getBoundingClientRect();
    const statsRect = completeStats.getBoundingClientRect();
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
        display: completeStyle.display,
        flexWrap: completeStyle.flexWrap,
        containerLeft: completeRect.left,
        containerRight: completeRect.right,
        paddingLeft: Number.parseFloat(completeStyle.paddingLeft),
        paddingRight: Number.parseFloat(completeStyle.paddingRight),
        labelLeft: labelRect.left,
        statsRight: statsRect.right,
        labelText: completeLabel.textContent?.trim() ?? "",
        statsText: completeStats.textContent?.trim() ?? "",
        statsTextAlign: statsStyle.textAlign,
      },
      completeText: elements[2]?.textContent ?? "",
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

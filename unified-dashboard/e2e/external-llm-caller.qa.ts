import type { Browser } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.LLM_CALLER_QA_OUTPUT
    ?? path.join("e2e", "screenshots", "external-llm-caller"),
);

const result = await runPlaywrightLifecycle({
  lockName: "external-llm-caller",
  timeoutMs: 120_000,
}, async ({ browser }) => verifyCallerFrame(browser));

console.log(JSON.stringify({ ok: true, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyCallerFrame(browser: Browser) {
  const context = await browser.newContext({
    colorScheme: "dark",
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 900, height: 760 },
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await page.goto(`${baseUrl}/e2e/external-llm-caller.fixture.html`, {
      waitUntil: "domcontentloaded",
    });
    const frame = page.getByTestId("session-info-frame");
    await frame.waitFor({ state: "visible", timeout: 20_000 });
    await page.getByText("🧠 source", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("External LLM", { exact: true }).waitFor({ state: "visible" });

    const metrics = await frame.evaluate((element) => {
      const rows = Array.from(element.querySelectorAll<HTMLElement>(".items-baseline"));
      const callerRow = rows.find((row) => row.textContent?.includes("🧠 source"));
      const nodeRow = rows.find((row) => row.textContent?.trim().startsWith("node"));
      const callerRect = callerRow?.getBoundingClientRect();
      const nodeRect = nodeRow?.getBoundingClientRect();
      return {
        frameWidth: element.getBoundingClientRect().width,
        callerVisible: Boolean(callerRect?.width && callerRect?.height),
        nodeVisible: Boolean(nodeRect?.width && nodeRect?.height),
        rowsOverlap: callerRect && nodeRect
          ? callerRect.bottom > nodeRect.top
          : true,
      };
    });

    assert(metrics.frameWidth >= 380, `세션 정보 프레임 폭이 너무 좁습니다: ${metrics.frameWidth}`);
    assert(metrics.callerVisible, "LLM source 행이 보이지 않습니다.");
    assert(metrics.nodeVisible, "인접 agent_node 행이 보이지 않습니다.");
    assert(!metrics.rowsOverlap, "LLM source 행과 인접 agent_node 행이 겹칩니다.");
    assert(browserErrors.length === 0, `브라우저 오류: ${browserErrors.join(" | ")}`);

    mkdirSync(outputRoot, { recursive: true });
    await frame.screenshot({
      path: path.join(outputRoot, "session-info-frame.png"),
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

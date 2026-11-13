import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installChatUiRoutes, openChatUi } from "./chat-ui-fixtures";

const output = path.resolve(import.meta.dirname, "../../.local/artifacts/card1316/web");
mkdirSync(output, { recursive: true });

const INTERRUPT_MESSAGE = "멈출 작업이 없습니다. 이미 끝난 세션일 수 있습니다.";
const APPROVAL_MESSAGE = "연결하지 못해 보내지 못했습니다. 다시 눌러 주세요.";
const records: Record<string, unknown> = {};

async function capture(target: Locator, name: string) {
  const page = target.page();
  await page.evaluate(() => document.fonts.ready);
  await target.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" });
}

function composer(page: Page) {
  return page.locator('[data-testid="chat-input"]').filter({ visible: true }).first();
}

for (const pas of [false, true]) for (const width of [1440, 360]) {
  test(`interrupt failure shows everyday wording ${pas ? "PAS" : "column"} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const h = await installChatUiRoutes(page, { example: pas ? "pas" : "normal" });
    const interruptCalls: string[] = [];
    await page.route(/\/api\/sessions\/[^/]+\/interrupt$/, route => {
      interruptCalls.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 409, json: { error: { code: "SESSION_NOT_RUNNING" } } });
    });
    await openChatUi(page, pas);
    const input = composer(page);
    const stop = input.getByRole("button", { name: "Stop running conversation" });
    await expect(stop).toBeEnabled();
    await expect(input.getByText(INTERRUPT_MESSAGE, { exact: true })).toHaveCount(0);

    const label = `interrupt-${pas ? "pas" : "chat"}-${width}`;
    await capture(input, `web-${label}-before`);
    await stop.click();
    await expect(input.getByText(INTERRUPT_MESSAGE, { exact: true })).toBeVisible();
    await expect(stop).toBeEnabled();
    await capture(input, `web-${label}-after`);

    expect(interruptCalls).toHaveLength(1);
    expect(h.errors).toEqual([]);
    records[label] = { message: INTERRUPT_MESSAGE, requested: interruptCalls, stopEnabled: await stop.isEnabled() };
  });
}

for (const width of [1440, 360]) {
  test(`tool approval failure shows everyday wording ${width}`, async ({ page }) => {
    // 승인 카드가 화면 안에 들어오도록 대화를 줄이고 세로를 넉넉히 잡는다. 목록이 길면
    // 카드가 화면 위로 밀려 캡처가 빈 영역을 찍는다. 폭은 기준 그대로 1440과 360이다.
    await page.setViewportSize({ width, height: 1400 });
    const h = await installChatUiRoutes(page, { example: "normal", count: 5, questions: true });
    const approvalCalls: string[] = [];
    await page.route(/\/api\/sessions\/[^/]+\/tool-approvals\/[^/]+\/approve$/, route => {
      approvalCalls.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 503, json: { error: { code: "NODE_UNAVAILABLE" } } });
    });
    const root = await openChatUi(page, true);
    // 승인 카드 자신을 잡는다. 승인 단추에서 위로 두 칸(단추 줄 → 카드) 올라가 상자를 정한다.
    const approve = root.getByRole("button", { name: "승인", exact: true }).first();
    const card = approve.locator("xpath=../..");
    await expect(card).toBeVisible();
    await expect(approve).toBeEnabled();
    await expect(card.getByRole("alert")).toHaveCount(0);

    const label = `approval-${width}`;
    // 짧은 대화라 카드가 화면 안에 있다. 실패 문구가 붙기 전후를 같은 상자로 찍는다.
    await capture(card, `web-${label}-before`);
    await approve.click();
    await expect(card.getByRole("alert")).toHaveText(APPROVAL_MESSAGE);
    await expect(approve).toBeEnabled();
    await capture(card, `web-${label}-after`);

    expect(approvalCalls).toHaveLength(1);
    expect(h.errors).toEqual([]);
    records[label] = { message: APPROVAL_MESSAGE, requested: approvalCalls };
  });
}

test.afterAll(() => {
  writeFileSync(path.join(output, "action-failure-metrics.json"), JSON.stringify(records, null, 2));
});

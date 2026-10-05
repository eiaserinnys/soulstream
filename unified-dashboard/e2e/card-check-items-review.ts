import { expect, type Locator, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import path from "node:path";

const textSelectors = [".v3-card-now-meta time", ".v3-card-check-item-no-image", ".v3-card-check-item-meta",
  ".v3-card-check-item-target", ".v3-card-check-item-state", ".v3-card-check-item-title",
  ".v3-card-check-item-number", ".v3-card-confirmed-group > button > span", ".v3-card-now-turn span",
  ".v3-card-now-turn strong", ".v3-card-comment-target", ".v3-card-note-more"];

/** Use the reviewer's top / 330px / bottom positions; sample background pixels separately. */
export async function textEvidence(page: Page, detail: Locator, output: string, name: string) {
  const values = await detail.evaluate((d, selectors) => {
    const scroll = d.querySelector(".v3-card-panel-scroll")!.getBoundingClientRect();
    const dock = d.querySelector(".v3-card-composer-slot")!.getBoundingClientRect();
    const canvas = document.createElement("canvas");canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    return selectors.flatMap(selector => [...d.querySelectorAll<HTMLElement>(selector)].flatMap(el => {
      if (!el.offsetParent || getComputedStyle(el).visibility === "hidden" || !el.textContent?.trim()) return [];
      const range = document.createRange();range.selectNodeContents(el);
      const rect = range.getBoundingClientRect();
      if (rect.width < 6 || rect.height < 6) return [];
      if (el.closest(".v3-card-panel-scroll") && (rect.top < scroll.top + 2 || rect.bottom > dock.top - 26)) return [];
      const style = getComputedStyle(el);
      ctx.clearRect(0, 0, 1, 1);ctx.fillStyle = style.color;ctx.fillRect(0, 0, 1, 1);
      return [{ selector, text: el.textContent?.trim(), item: el.closest("[data-item-id]")?.getAttribute("data-item-id"),
        color: style.color, rgba: [...ctx.getImageData(0, 0, 1, 1).data], font: `${style.fontWeight} ${style.fontSize}/${style.lineHeight}`,
        box: [rect.left, rect.top, rect.right, rect.bottom] }];
    }));
  }, textSelectors);
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" });
  const hide = await page.addStyleTag({ content: ".v3-card-detail *, .v3-card-detail *::before {color:transparent!important;text-shadow:none!important}" });
  await page.screenshot({ path: path.join(output, `${name}-background.png`), animations: "disabled" });
  await hide.evaluate(el => el.remove());
  writeFileSync(path.join(output, `${name}.json`), JSON.stringify(values, null, 2));
  return values;
}

export async function reviewCorrections(page: Page, width: number, output: string) {
  const board = page.getByTestId("card-board-sample");
  await board.scrollIntoViewIfNeeded();
  await board.getByTestId("postit-size-comparison").screenshot({ path: path.join(output, `${width}-postit-sizes.png`) });
  const open = async () => {
    await board.getByTestId("postit-size-comparison").locator(".v3-postit-open").first().click();
    await expect(page.getByTestId("card-detail")).toBeVisible();
  };
  await open();
  const detail = page.getByTestId("card-detail"), panel = detail.getByTestId("card-now-panel");
  const scroll = detail.locator(".v3-card-panel-scroll");
  await page.evaluate(() => document.fonts.ready);
  await expect(detail.getByRole("tab", { name: /^세션/ })).toHaveText("세션1");
  await expect(detail.getByRole("tab", { name: /^노트/ })).toHaveText("노트6");
  await detail.getByRole("tablist").screenshot({ path: path.join(output, `${width}-tabs.png`) });
  const fonts = await textEvidence(page, detail, output, `${width}-contrast-top`);
  expect(fonts.find(value => value.selector === ".v3-card-check-item-title")?.font).toBe("600 16px/23px");
  expect(fonts.find(value => value.selector === ".v3-card-check-item-number")?.font).toBe("600 16px/23px");
  expect(fonts.find(value => value.selector === ".v3-card-check-item-target")?.font).toBe("500 12px/18px");
  expect(fonts.find(value => value.selector === ".v3-card-check-item-state")?.font).toBe("700 12px/18px");
  for (const [label, offset] of [["bottom", -1], ["mid", 330]] as const) {
    await scroll.evaluate((el, y) => { el.scrollTop = y < 0 ? el.scrollHeight : y; }, offset);
    await textEvidence(page, detail, output, `${width}-contrast-${label}`);
  }
  await scroll.evaluate(el => { el.scrollTop = 0; });
  const geometry = () => detail.evaluate(d => {
    const panel = d.querySelector("[data-testid=card-now-panel]")!.getBoundingClientRect();
    const text = d.querySelector(".v3-card-now-text")!.getBoundingClientRect();
    return { height: panel.height, itemY: d.querySelector("[data-testid=card-check-items]")!.getBoundingClientRect().y, textHeight: text.height };
  });
  await page.waitForTimeout(1000);
  const latest = await geometry();
  await panel.getByRole("button", { name: "이전 상황" }).click();
  await page.waitForTimeout(1000);
  const past = await geometry();
  expect(Math.abs(past.height - latest.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(past.itemY - latest.itemY)).toBeLessThanOrEqual(1);
  expect(past.textHeight).toBeGreaterThan(0);
  await page.screenshot({ path: path.join(output, `${width}-past-after-1s.png`), animations: "disabled" });
  const divider = page.getByTestId("v3-card-workspace-divider");
  const drag = async (delta: number) => {
    const r = (await divider.locator(".cursor-col-resize").boundingBox())!;
    await page.mouse.move(r.x + r.width / 2, r.y + 80);await page.mouse.down();
    await page.mouse.move(r.x + r.width / 2 + delta, r.y + 80);await page.mouse.up();
  };
  await drag(-67);await page.waitForTimeout(1000);
  const resizedPast = await geometry();
  await panel.getByRole("button", { name: "최신으로", exact: true }).click();
  await page.waitForTimeout(1000);
  const resizedLatest = await geometry();
  expect(Math.abs(resizedPast.height - resizedLatest.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(resizedPast.itemY - resizedLatest.itemY)).toBeLessThanOrEqual(1);
  expect(resizedPast.textHeight).toBeGreaterThan(0);
  const row = detail.locator('[data-item-id="4"]');
  await row.scrollIntoViewIfNeeded();
  const title = (await row.locator(".v3-card-check-item-title").boundingBox())!;
  const state = (await row.locator(".v3-card-check-item-state").boundingBox())!;
  expect(Math.abs(title.x - state.x)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join(output, `${width}-split-399.png`), animations: "disabled" });
  await drag(-1000);await page.waitForTimeout(1000);
  const minimum = await panel.evaluate(el => {
    const h = el.querySelector(".v3-card-now-header")!.getBoundingClientRect();
    const label = el.querySelector("strong")!.getBoundingClientRect(), time = el.querySelector("time")!.getBoundingClientRect();
    const actions = el.querySelector(".v3-card-now-actions")!.getBoundingClientRect();
    return { headerHeight: h.height, labelHeight: label.height, timeY: time.y, labelY: label.y, timeRight: time.right, actionsX: actions.x };
  });
  expect(minimum.headerHeight).toBe(18);expect(minimum.labelHeight).toBeLessThanOrEqual(18);
  expect(minimum.timeY).toBe(minimum.labelY);expect(minimum.timeRight).toBeLessThanOrEqual(minimum.actionsX);
  await page.screenshot({ path: path.join(output, `${width}-minimum-${width === 1440 ? 268 : 388}.png`), animations: "disabled" });
  await divider.focus();await page.keyboard.press("Home");
  await scroll.evaluate(el => { el.scrollTop = 0; });
  const focus = [];
  for (const [label, selector] of [["checkbox", '[data-item-id="1"] [role="checkbox"]'], ["title", ".v3-card-title-button"], ["link", '.v3-card-check-item-links a']] as const) {
    const el = detail.locator(selector).first();await el.scrollIntoViewIfNeeded();
    await page.keyboard.press("Tab");await el.focus();
    await el.evaluate(node => Promise.all(node.getAnimations().filter(animation => animation instanceof CSSTransition).map(animation => animation.finished)));
    const style = await el.evaluate(node => ({ shadow: getComputedStyle(node).boxShadow, outline: getComputedStyle(node).outlineWidth, outlineStyle: getComputedStyle(node).outlineStyle, html: node.outerHTML.slice(0, 600), matchesCardRule: node.matches(".v3-card-check-item-heading [data-slot=checkbox]:focus-visible"), visible: node.matches(":focus-visible") }));
    writeFileSync(path.join(output, `${width}-focus-${label}.json`), JSON.stringify(style, null, 2));
    expect(style.visible).toBe(true);expect(style.shadow).not.toBe("none");expect(style.outlineStyle).toBe("none");
    focus.push({ label, ...style });
    await page.screenshot({ path: path.join(output, `${width}-focus-${label}.png`), animations: "disabled" });
  }
  await detail.getByRole("tab", { name: /^노트/ }).click();
  const noteFont = await textEvidence(page, detail, output, `${width}-notes-review`);
  expect(noteFont.find(value => value.selector === ".v3-card-note-more")?.font).toBe("500 12px/18px");
  await expect(detail.locator(".v3-card-note-row")).toHaveCount(5);
  await expect(detail.locator(".v3-card-note-row > .w-8")).toHaveCount(5);
  await detail.getByRole("tab", { name: "커멘트", exact: true }).click();
  const target = detail.locator(".v3-card-comment-target");
  const targetColor = await target.evaluate(el => ({ target: getComputedStyle(el).color, parent: getComputedStyle(el.parentElement!).color }));
  expect(targetColor.target).toBe(targetColor.parent);
  await textEvidence(page, detail, output, `${width}-comment-target-review`);
  await detail.getByRole("button", { name: "카드 닫기", exact: true }).click();
  for (const [label, turn] of [["에이전트 차례 띠", "agent"], ["바깥 대기 띠", "outside"], ["상황판 없이 모두 확인", "none"], ["확인함 두 개", "two"]] as const) {
    await board.getByTestId("card-check-scenarios").getByRole("button", { name: label, exact: true }).click();await open();
    if (turn === "none") {
      await expect(panel).toHaveCount(0);await expect(detail.locator(".v3-folder-header-actions")).toHaveAttribute("data-complete-emphasis", "true");
    } else if (turn === "two") {
      await expect(detail.getByTestId("confirmed-items-group")).toHaveCount(0);
      await expect(detail.locator('[data-item-display="confirmed"]')).toHaveCount(2);
    } else await expect(panel.locator(`.v3-card-now-turn--${turn}`)).toContainText(label.replace(" 띠", ""));
    await page.screenshot({ path: path.join(output, `${width}-sample-${turn}.png`), animations: "disabled" });
    await detail.getByRole("button", { name: "카드 닫기", exact: true }).click();
  }
  writeFileSync(path.join(output, `${width}-review-metrics.json`), JSON.stringify({ latest, past, resizedPast, resizedLatest, minimum, focus, targetColor }, null, 2));
}

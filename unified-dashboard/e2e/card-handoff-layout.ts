import { expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export async function verifyHandoffLayout(page: Page, output: string, name: string) {
  const dir = path.join(output, name);
  mkdirSync(dir, { recursive: true });
  const input = page.getByRole("textbox", { name: "무엇을 맡길까요" });
  await expect(page.getByRole("combobox", { name: "모델 선택" })).toContainText("QA 표준 모델");
  const measure = () => page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const textarea = document.querySelector<HTMLTextAreaElement>(".v3-card-handoff textarea")!;
    const inputStyle = getComputedStyle(textarea);
    const fields = Array.from(document.querySelectorAll<HTMLElement>(".v3-card-handoff-controls select, .v3-card-handoff-controls button"))
      .map(element => {
        const r = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { text: element instanceof HTMLSelectElement ? element.selectedOptions[0].text : element.textContent,
          x: r.x, y: r.y, right: r.right, height: r.height, width: r.width,
          clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, alignItems: style.alignItems };
      });
    return { column: rect(".v3-planner-column--daily"), list: rect(".v3-today-list"),
      section: rect(".v3-card-inbox .v3-section-head"), handoff: rect(".v3-today-handoff"),
      input: rect(".v3-card-handoff textarea"), fields,
      controlHeight: parseFloat(getComputedStyle(document.querySelector(".v3-shell")!).getPropertyValue("--v3-control-height")),
      maxInputHeight: parseFloat(inputStyle.lineHeight) * 6 + parseFloat(inputStyle.paddingTop) + parseFloat(inputStyle.paddingBottom)
        + parseFloat(inputStyle.borderTopWidth) + parseFloat(inputStyle.borderBottomWidth),
      inputScrollHeight: textarea.scrollHeight, listScrollHeight: document.querySelector(".v3-today-list")!.scrollHeight };
  });
  const initial = await measure();
  expect(Math.abs(initial.input.x - initial.section.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(initial.input.right - initial.section.right)).toBeLessThanOrEqual(1);
  expect(Math.abs(initial.handoff.bottom - initial.column.bottom)).toBeLessThanOrEqual(1);
  expect(initial.input.width).toBe(initial.list.width);
  for (const field of initial.fields) {
    expect(field.height).toBe(initial.controlHeight);
    expect(field.right).toBeLessThanOrEqual(initial.column.right + 1);
    expect(field.x).toBeGreaterThanOrEqual(initial.column.x - 1);
    // Only the folder chip is intentionally capped and ellipsized.
    if (field.text !== "소울스트림") expect(field.scrollWidth).toBeLessThanOrEqual(field.clientWidth + 1);
  }
  await page.screenshot({ path: path.join(dir, "today.png") });
  await input.fill("첫째 줄");
  await input.press("Shift+Enter");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("첫째 줄\n\n");
  const multiline = await measure();
  expect(multiline.input.height).toBeGreaterThan(initial.input.height);
  expect(multiline.fields.map(field => field.height)).toEqual(initial.fields.map(field => field.height));
  await page.screenshot({ path: path.join(dir, "multiline.png") });
  await input.fill(Array.from({ length: 8 }, (_, i) => `입력 ${i + 1}`).join("\n"));
  const maximum = await measure();
  expect(maximum.input.height).toBeCloseTo(maximum.maxInputHeight, 0);
  expect(maximum.inputScrollHeight).toBeGreaterThan(maximum.input.height);
  expect(maximum.fields.map(field => field.height)).toEqual(initial.fields.map(field => field.height));
  await input.fill("");
  await page.locator(".v3-today-list").evaluate(element => { element.scrollTop = element.scrollHeight; });
  const last = await page.locator('.v3-card-inbox [data-card-id]').last().boundingBox();
  const end = await measure();
  expect(end.listScrollHeight).toBeGreaterThan(end.list.height);
  expect(last!.y).toBeGreaterThanOrEqual(end.list.y);
  expect(last!.y + last!.height).toBeLessThanOrEqual(end.list.bottom + 1);
  expect(end.handoff).toEqual(initial.handoff);
  await page.screenshot({ path: path.join(dir, "scroll-end.png") });
  writeFileSync(path.join(dir, "layout.json"), JSON.stringify({ initial, multiline, maximum, end, last }, null, 2));
  await page.locator(".v3-today-list").evaluate(element => { element.scrollTop = 0; });
}

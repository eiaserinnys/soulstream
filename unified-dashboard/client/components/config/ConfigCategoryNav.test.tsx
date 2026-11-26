/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfigCategoryNav } from "./ConfigCategoryNav";
import { visibleConfigTabs } from "./configTabs";

const ROW_HEIGHT = 44;
const NAV_HEIGHT = 100;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.tagName === "NAV" ? NAV_HEIGHT : 0; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.tagName === "NAV") return { top: 0, bottom: NAV_HEIGHT, height: NAV_HEIGHT } as DOMRect;
    const nav = this.closest("nav")!;
    const index = [...nav.querySelectorAll("button")].indexOf(this as HTMLButtonElement);
    const top = index * ROW_HEIGHT - nav.scrollTop;
    return { top, bottom: top + ROW_HEIGHT, height: ROW_HEIGHT } as DOMRect;
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const tabs = visibleConfigTabs(true);
const render = (activeCategory: string, onSelect = vi.fn()) => act(async () => root.render(<ConfigCategoryNav categories={[]} tabs={tabs} activeCategory={activeCategory} onSelect={onSelect} />));
const nav = () => container.querySelector("nav")!;
const row = (name: string) => [...nav().querySelectorAll("button")][tabs.findIndex(tab => tab.id === name)];

it("목차 밖에서 정해진 칸이 안 보이면 목차 스크롤 영역만 움직여 그 칸을 다 보이게 한다", async () => {
  await render("appearance");
  expect(nav().scrollTop).toBe(0);
  await render("coding_agents");
  const box = row("coding_agents").getBoundingClientRect();
  expect(nav().scrollTop).toBeGreaterThan(0);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.bottom).toBeLessThanOrEqual(NAV_HEIGHT);
  await render("agents");
  const moved = row("agents").getBoundingClientRect();
  expect(moved.top).toBeGreaterThanOrEqual(0);
  expect(moved.bottom).toBeLessThanOrEqual(NAV_HEIGHT);
});

it("처음부터 열린 칸이 안 보이는 자리에 있어도 처음 그릴 때 보이게 한다", async () => {
  await render("coding_agents");
  const box = row("coding_agents").getBoundingClientRect();
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.bottom).toBeLessThanOrEqual(NAV_HEIGHT);
});

it("목차를 직접 누르면 일부만 보이는 칸이어도 목차가 움직이지 않는다", async () => {
  const onSelect = vi.fn();
  await render("appearance", onSelect);
  await act(async () => row("persistent").click());
  await render("persistent", onSelect);
  expect(onSelect).toHaveBeenCalledWith("persistent");
  expect(nav().scrollTop).toBe(0);
});

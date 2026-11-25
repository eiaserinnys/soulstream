/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { SettingsDetailHeader, SettingsListDetailFrame, SettingsListHeader, SettingsListRow } from "./SettingsListDetail";

it("기존 상세 머리는 아이콘 없이 같은 구조이며 선택한 아이콘만 앞에 둔다", () => {
  const before = '<header class="flex flex-wrap items-start justify-between gap-2"><div><h3 class="text-base font-semibold">반복 작업</h3><p data-v3-selectable-content="true" class="text-xs text-muted-foreground">설명</p></div></header>';
  expect(renderToStaticMarkup(<SettingsDetailHeader title="반복 작업" subtitle="설명" />)).toBe(before);
  const withIcon = renderToStaticMarkup(<SettingsDetailHeader title="서버" leadingIcon={<span>아이콘</span>} />);
  expect(withIcon.indexOf('아이콘')).toBeLessThan(withIcon.indexOf('서버'));
});

it("keeps Korean words together in the list description", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SettingsListHeader title="목록" description="목록 설명" actions={null} />));
    const description = container.querySelector("p")!;
    expect(description.classList.contains("break-keep")).toBe(true);
    expect(description.classList.contains("break-words")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("renders each settings row as a block button", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SettingsListRow title="세션" meta="에이전트" selected={false} onSelect={() => undefined} />));
    expect(container.querySelector("button")?.classList.contains("block")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
it("선택한 상세가 보이면 그대로 두고 화면 밖이면 머리로 스크롤한다", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  const host = document.createElement("div");
  host.className = "config-detail";
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(
      <SettingsListDetailFrame testId="frame" list={
        <SettingsListRow title="항목" meta="" selected={false} onSelect={() => undefined} />
      }>
        <header>상세</header>
      </SettingsListDetailFrame>,
    ));
    const frame = host.querySelector('[data-testid="frame"]')!;
    const detail = frame.lastElementChild!;
    const header = detail.querySelector("header")!;
    const scroll = vi.fn();
    header.scrollIntoView = scroll;
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 500, 400));
    vi.spyOn(detail, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 120, 500, 380));
    const position = vi.spyOn(header, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 160, 200, 40));
    await act(async () => frame.querySelector("button")!.click());
    expect(scroll).not.toHaveBeenCalled();
    position.mockReturnValue(new DOMRect(0, 50, 200, 40));
    await act(async () => frame.querySelector("button")!.click());
    expect(scroll).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("clampSubtitle은 좁은 폭에서 부제를 세 줄로 접고, 넘칠 때만 「더 보기」 단추를 둔다", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get");
  const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get");
  try {
    // 넘치지 않으면 단추가 없다.
    scrollHeight.mockReturnValue(54); clientHeight.mockReturnValue(54);
    await act(async () => root.render(<SettingsDetailHeader title="스킬" subtitle="짧은 설명" inlineActions clampSubtitle />));
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector("p")!.className).toContain("max-sm:line-clamp-3");
    // 넘치면 단추가 서고, 누르면 펼쳐져 접기로 바뀐다.
    scrollHeight.mockReturnValue(144);
    await act(async () => root.render(<SettingsDetailHeader title="스킬" subtitle="아주 긴 설명" inlineActions clampSubtitle />));
    const toggle = host.querySelector("button")!;
    expect(toggle.textContent).toBe("더 보기");
    await act(async () => toggle.click());
    expect(host.querySelector("p")!.className).not.toContain("line-clamp");
    expect(host.querySelector("button")!.textContent).toBe("접기");
    expect(host.querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    // clampSubtitle을 안 주면 기존 마크업 그대로다.
    await act(async () => root.render(<SettingsDetailHeader title="스킬" subtitle="설명" inlineActions />));
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector("p")!.className).toBe("text-xs text-muted-foreground");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

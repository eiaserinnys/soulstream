/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { V3GlobalToolbar } from "./V3GlobalToolbar";

const atom = vi.hoisted(() => ({ url: null as string | null }));
vi.mock("@seosoyoung/soul-ui", async () => {
  const actual = await vi.importActual<typeof import("@seosoyoung/soul-ui")>("@seosoyoung/soul-ui");
  return {
    ...actual,
    useAtomPublicUrl: () => atom.url,
    ThemeToggle: () => <button aria-label="테마 전환" />,
    useGlassSurface: () => false,
    useLiquidLens: () => undefined,
  };
});
vi.mock("../components/ConfigButton", () => ({ ConfigButton: () => <button aria-label="설정" /> }));
vi.mock("./PersistentSessionEntry", () => ({ PersistentSessionEntry: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  atom.url = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const minimalToolbar = (onToggleUsage = vi.fn()) => (
  <V3GlobalToolbar
    variant="minimal"
    appearance="bare"
    sessionName="대화 제목"
    agentName="서소영 (PAS)"
    agentOnly={false}
    sessionSwitch={<button aria-label="영구 세션 바꾸기" />}
    showWeeklyUsage
    onToggleUsage={onToggleUsage}
    onOpenConfig={() => undefined}
  />
);
const actionLabels = () => [...host.querySelector(".dashboard-toolbar-actions")!.children].map(element => element.getAttribute("aria-label"));

it("uses the actual agent name in the minimal PAS header and keeps a stable usage toggle", () => {
  const onToggleUsage = vi.fn();
  act(() => root.render(minimalToolbar(onToggleUsage)));

  const brand = host.querySelector(".persistent-session-brand")!;
  expect(brand.textContent).toContain("소울스트림");
  expect(brand.textContent).toContain("서소영 (PAS)");
  expect(brand.textContent).not.toContain("대화 제목");
  expect(actionLabels()).toEqual(["영구 세션 바꾸기", "홈", "테마 전환", "주간 사용량", "설정"]);

  const toggle = host.querySelector<HTMLButtonElement>(".persistent-session-weekly-usage-toggle")!;
  expect(toggle).not.toBeNull();
  expect(toggle.getAttribute("aria-label")).toBe("주간 사용량");
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(toggle.getAttribute("type")).toBe("button");
  act(() => toggle.click());
  expect(onToggleUsage).toHaveBeenCalledOnce();
});

it("puts the atom button right before the settings button in the minimal toolbar when atom is connected", () => {
  atom.url = "https://atom.example.test";
  act(() => root.render(minimalToolbar()));
  expect(actionLabels()).toEqual(["영구 세션 바꾸기", "홈", "테마 전환", "주간 사용량", "atom 열기", "설정"]);
  expect(host.querySelector('[data-testid="atom-dashboard-button"]')?.getAttribute("aria-label")).toBe("atom 열기");
});

it("opens the atom dashboard in a new tab without an opener", () => {
  atom.url = "https://atom.example.test";
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    act(() => root.render(minimalToolbar()));
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="atom-dashboard-button"]')!.click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://atom.example.test", "_blank", "noopener,noreferrer");
  } finally {
    open.mockRestore();
  }
});

it("leaves the default toolbar brand, search, and actions intact", () => {
  act(() => root.render(
    <V3GlobalToolbar
      onOpenConfig={() => undefined}
      onOpenSearch={() => undefined}
      onToggleUsage={() => undefined}
      showWeeklyUsage
    />,
  ));

  expect(host.querySelector(".dashboard-floating-toolbar .dashboard-toolbar-brand")?.textContent).toContain("Soulstream");
  expect(host.querySelector('[aria-label="세션 검색 열기"]')).not.toBeNull();
  expect(host.querySelector(".persistent-session-weekly-usage-toggle")).toBeNull();
});

it("shows the atom button in the default toolbar between the PAS entry and settings, and hides it without an address", () => {
  const defaultToolbar = () => <V3GlobalToolbar onOpenConfig={() => undefined} onOpenSearch={() => undefined} />;
  act(() => root.render(defaultToolbar()));
  expect(host.querySelector('[data-testid="atom-dashboard-button"]')).toBeNull();
  expect(actionLabels()).toEqual(["설정", "테마 전환"]);

  atom.url = "https://atom.example.test";
  act(() => root.render(defaultToolbar()));
  expect(actionLabels()).toEqual(["atom 열기", "설정", "테마 전환"]);
});

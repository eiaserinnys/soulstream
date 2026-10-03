/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IosComponentsReviewPage } from "./IosComponentsReviewPage";

vi.mock("./ComponentsReviewLayout", () => ({
  ComponentsReviewLayout: ({ children, syncPreferences }: { children: ReactNode; syncPreferences: boolean }) => <main data-sync-preferences={String(syncPreferences)}>{children}</main>,
}));
vi.mock("@seosoyoung/soul-ui", () => ({
  DashboardIconCap: ({ label, children, onClick }: { label: string; children: ReactNode; onClick: () => void }) =>
    <button aria-label={label} onClick={onClick}>{children}</button>,
}));

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

it.each(["missing", "unreachable"])("shows preparation without an iframe when the bundle is %s", async mode => {
  if (mode === "missing") fetchMock.mockResolvedValue({ ok: false, status: 404 });
  else fetchMock.mockRejectedValue(new TypeError("Network error"));
  await act(async () => root.render(<IosComponentsReviewPage />));
  expect(container.querySelector('[role="status"]')?.textContent).toBe("앱 검수 화면을 준비 중입니다");
  expect(container.querySelector("iframe")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("checks the same-origin index once before displaying the named iframe", async () => {
  let resolveCheck!: (value: { ok: boolean }) => void;
  fetchMock.mockImplementation(() => new Promise(resolve => { resolveCheck = resolve; }));
  await act(async () => root.render(<IosComponentsReviewPage />));
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.querySelector("main")?.dataset.syncPreferences).toBe("true");
  expect(container.querySelector("h1")?.textContent).toBe("소울앱 컴포넌트");
  expect(container.textContent).toContain("앱 컴포넌트의 브라우저 미리보기입니다. iOS 전용 효과와 동작은 기기에서 확인합니다.");
  await act(async () => resolveCheck({ ok: true }));
  const frame = container.querySelector("iframe");
  expect(frame?.getAttribute("src")).toBe("/assets/ios-components/index.html");
  expect(frame?.getAttribute("title")).toBe("소울앱 컴포넌트 브라우저 미리보기");
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("/assets/ios-components/index.html", expect.objectContaining({
    method: "HEAD", cache: "no-store", signal: expect.any(AbortSignal),
  }));
});

it("opens the dialogues section in the same bundle and keeps the host frame", async () => {
  fetchMock.mockResolvedValue({ ok: true });
  await act(async () => root.render(<IosComponentsReviewPage section="dialogues" />));
  expect(container.querySelector("iframe")?.getAttribute("src")).toBe("/assets/ios-components/index.html?section=dialogues");
  expect(container.textContent).toContain("iOS 앱 컴포넌트의 웹 미리보기");
  expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("웹 다이얼로그로 돌아가기");
  expect(container.querySelector(".v3-ios-components-review")).not.toBeNull();
  expect(container.querySelector("main")?.dataset.syncPreferences).toBe("false");
});

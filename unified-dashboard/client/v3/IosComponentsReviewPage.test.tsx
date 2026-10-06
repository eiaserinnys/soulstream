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

vi.mock("./DialogueGallery", () => ({
  DialogueGallery: ({ platform, groups, description }: { platform: string; groups: {id: string; items: {id: string; title: string; src?: string; description?: string}[]}[]; description: string }) =>
    <main data-platform={platform}><p>{description}</p>{groups.map(group => <section key={group.id} data-group={group.id}>
      {group.items.map(item => item.src ? <iframe key={item.id} title={item.title} src={item.src} /> : <details key={item.id}><summary>기기 전용 안내</summary>{item.description}</details>)}
    </section>)}</main>,
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

it("opens all 21 originals in grouped single-sample frames without the legacy host", async () => {
  fetchMock.mockResolvedValue({ ok: true });
  await act(async () => root.render(<IosComponentsReviewPage section="dialogues" />));
  const frames = [...container.querySelectorAll('iframe')];
  expect(frames).toHaveLength(21);
  expect([...container.querySelectorAll('[data-group]')].slice(0, 6).map(group => group.querySelectorAll('iframe').length)).toEqual([3, 6, 3, 4, 2, 3]);
  expect(frames.every(frame => frame.getAttribute('src')?.startsWith('/assets/ios-components/index.html?section=dialogues&sample='))).toBe(true);
  expect(new Set(frames.map(frame => frame.getAttribute('src'))).size).toBe(21);
  expect(container.textContent).toContain('phone');
  expect(container.querySelector('.v3-ios-components-review')).toBeNull();
  expect(container.querySelector('main')?.dataset.platform).toBe('ios');
  expect(container.querySelector('details')?.open).toBe(false);
  expect(container.querySelector('details')?.textContent).toContain('폴더 보관');
  expect(container.querySelector('details')?.textContent).toContain('세션 이름 변경');
});

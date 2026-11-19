/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtomNodeSelector } from "./AtomNodeSelector";

describe("AtomNodeSelector presentation", () => {
  it("renders the open inline panel in the trigger's flow", () => {
    const html = renderToStaticMarkup(<AtomNodeSelector value="" onChange={vi.fn()} open presentation="inline" />);
    expect(html).toContain('data-slot="atom-node-selector-panel"');
    expect(html.indexOf("노드 선택")).toBeLessThan(html.indexOf('data-slot="atom-node-selector-panel"'));
    expect(html).toContain("루트");
    expect(html).not.toContain("max-h-48");
    expect(html).not.toContain("overflow-y-auto");
  });
  it("keeps the popup presentation as default", () => {
    const html = renderToStaticMarkup(<AtomNodeSelector value="" onChange={vi.fn()} open />);
    expect(html).toContain('data-slot="popover-trigger"');
    expect(html).not.toContain('data-slot="atom-node-selector-panel"');
  });
});

// 카드 #1699: 실패한 단계의 「다시 시도」와 결과별 초점 이동.
describe("AtomNodeSelector retry", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
  const failResponse = () => ({ ok: false, status: 503, json: async () => ({}) }) as Response;
  const node = (id: string, title: string) => ({ id, card_id: `card-${id}`, card: { title, card_type: "knowledge" as const } });
  const findButton = (label: string) =>
    [...container.querySelectorAll("button")].find(button => button.textContent === label);
  const findFirstNodeButton = (title: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === title);

  async function renderSelector(request: typeof fetch) {
    await act(async () => {
      root.render(<AtomNodeSelector value="" onChange={vi.fn()} open presentation="inline" request={request} />);
    });
    await act(async () => {});
  }

  it("shows the retry button in the list panel and focuses the first node after success", async () => {
    const urls: string[] = [];
    const request = vi.fn(async (url: string) => {
      urls.push(String(url));
      return urls.length <= 1 ? failResponse() : okResponse({ children: [node("a", "첫 노드"), node("b", "둘째 노드")] });
    }) as unknown as typeof fetch;

    await renderSelector(request);

    const panel = container.querySelector('[data-slot="atom-node-selector-panel"]');
    expect(panel?.textContent).toContain("노드를 불러오지 못했습니다");
    const retry = panel?.querySelector<HTMLButtonElement>("button") &&
      [...panel.querySelectorAll("button")].find(button => button.textContent === "다시 시도");
    expect(retry).toBeTruthy();

    await act(async () => { retry!.click(); });
    await act(async () => {});

    const first = findFirstNodeButton("첫 노드");
    expect(first).toBeTruthy();
    expect(container.textContent).not.toContain("노드를 불러오지 못했습니다");
    expect(document.activeElement).toBe(first);
    expect(urls).toEqual(["/api/atom/nodes", "/api/atom/nodes"]);
  });

  it("keeps focus on the retry button when the retry fails again", async () => {
    const request = vi.fn(async () => failResponse()) as unknown as typeof fetch;

    await renderSelector(request);
    const retry = findButton("다시 시도");
    expect(retry).toBeTruthy();

    await act(async () => { retry!.click(); });
    await act(async () => {});

    expect(container.textContent).toContain("노드를 불러오지 못했습니다");
    expect(document.activeElement).toBe(findButton("다시 시도"));
  });

  it("reloads the current level after a child-level failure", async () => {
    const urls: string[] = [];
    const request = vi.fn(async (url: string) => {
      urls.push(String(url));
      if (url === "/api/atom/nodes") return okResponse({ children: [node("a", "첫 노드"), node("b", "둘째 노드")] });
      if (urls.filter(seen => seen.endsWith("/children")).length === 1) return failResponse();
      return okResponse({ children: [node("a-1", "하위 노드")] });
    }) as unknown as typeof fetch;

    await renderSelector(request);
    const into = container.querySelector<HTMLButtonElement>('[title="자식 보기"]');
    expect(into).toBeTruthy();

    await act(async () => { into!.click(); });
    await act(async () => {});
    expect(container.textContent).toContain("노드를 불러오지 못했습니다");

    const retry = findButton("다시 시도");
    await act(async () => { retry!.click(); });
    await act(async () => {});

    expect(container.textContent).toContain("하위 노드");
    expect(urls[2]).toBe("/api/atom/nodes/a/children");
  });
});

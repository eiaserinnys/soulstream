/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDashboardStore } from "../stores/dashboard-store";
import { MarkdownDocumentPanel } from "./MarkdownDocumentPanel";

function renderPanel() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  useDashboardStore.getState().reset();
  useDashboardStore.getState().setActiveBoardDocument("doc-a");
  flushSync(() => {
    root.render(createElement(MarkdownDocumentPanel));
  });
  return { container, root };
}

async function waitForSelector<T extends Element>(container: ParentNode, selector: string): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const element = container.querySelector<T>(selector);
    if (element) return element;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

async function waitForFetchBody(fetchMock: ReturnType<typeof vi.fn>, body: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const matched = fetchMock.mock.calls.some(([, init]) => init?.method === "PUT" && init.body === body);
    if (matched) return;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for fetch body ${body}. Calls: ${JSON.stringify(fetchMock.mock.calls)}`);
}

async function waitForText(container: ParentNode, selector: string, text: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (container.querySelector(selector)?.textContent === text) return;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${selector} text ${text}`);
}

function setNativeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  valueSetter?.call(textarea, value);
}

describe("MarkdownDocumentPanel", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/catalog/markdown-documents/doc-a") && !init) {
        return new Response(JSON.stringify({
          id: "doc-a",
          title: "Design note",
          body: "Initial body",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/api/catalog/markdown-documents/doc-a") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({
          id: "doc-a",
          title: body.title,
          body: body.body,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    container?.remove();
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
  });

  it("switches to a textarea on body click and saves edited body on blur", async () => {
    ({ container, root } = renderPanel());

    const readBody = await waitForSelector<HTMLElement>(container, '[data-testid="markdown-read-body"]');
    expect(readBody.textContent).toContain("Initial body");

    flushSync(() => {
      readBody!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();

    flushSync(() => {
      setNativeTextareaValue(textarea!, "Edited body");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      textarea!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await Promise.resolve();

    flushSync(() => {
      textarea!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await waitForFetchBody(fetchMock, JSON.stringify({ title: "Design note", body: "Edited body" }));

    expect(fetchMock.mock.calls).toContainEqual([
      "/api/catalog/markdown-documents/doc-a",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ title: "Design note", body: "Edited body" }),
      }),
    ]);
    await waitForText(container, '[data-testid="markdown-save-status"]', "저장됨");
    expect(container.querySelector('[data-testid="markdown-save-status"]')?.textContent).toBe("저장됨");
  });

  it("restores the last saved body when Escape is pressed", async () => {
    ({ container, root } = renderPanel());

    const readBody = await waitForSelector<HTMLElement>(container, '[data-testid="markdown-read-body"]');
    flushSync(() => {
      readBody.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();

    flushSync(() => {
      setNativeTextareaValue(textarea!, "Draft body");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      textarea!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    flushSync(() => {
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector('[data-testid="markdown-read-body"]')?.textContent).toContain("Initial body");
  });
});

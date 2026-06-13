/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDashboardStore } from "../stores/dashboard-store";
import { RightPanel } from "./RightPanel";

vi.mock("./chat", () => ({ ChatView: () => createElement("div", null, "chat") }));
vi.mock("./DetailView", () => ({ DetailView: () => createElement("div", null, "detail") }));
vi.mock("./SessionInfoView", () => ({ SessionInfoView: () => createElement("div", null, "info") }));
vi.mock("./MarkdownDocumentPanel", () => ({
  MarkdownDocumentPanel: () => createElement("div", null, "document"),
}));

describe("RightPanel", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    useDashboardStore.getState().reset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
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

  it("centers the chat/detail/session info tab group", () => {
    flushSync(() => {
      root!.render(createElement(RightPanel));
    });

    const tabsList = container!.querySelector<HTMLElement>('[data-slot="tabs-list"]');
    expect(tabsList).not.toBeNull();
    expect(tabsList!.className).toContain("mx-auto");
    expect(tabsList!.className).not.toContain("mx-3");
  });
});

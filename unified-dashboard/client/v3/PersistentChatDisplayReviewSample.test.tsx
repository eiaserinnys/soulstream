/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { PersistentChatDisplayReviewSample } from "./PersistentChatDisplayReviewSample";

describe("PersistentChatDisplayReviewSample", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("renders the raw event pipeline output and can hide each projected row", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<PersistentChatDisplayReviewSample />));
    expect(container.textContent).toContain("이전 세대의 답변입니다.");
    expect(container.querySelector('[role="separator"]')?.getAttribute("aria-label")).toBe("새 세대");
    expect(container.textContent).toContain("Jev 후보 3");
    expect(container.textContent).toContain("관련 후보를 찾아줘");

    const switches = container.querySelectorAll<HTMLButtonElement>("[role=switch]");
    act(() => switches[0]?.click());
    act(() => switches[1]?.click());
    expect(container.querySelector('[role="separator"]')).toBeNull();
    expect(container.textContent).not.toContain("Jev 후보 3");
    expect(container.textContent).toContain("이전 세대의 답변입니다.");
    expect(container.textContent).toContain("관련 후보를 찾아줘");
  });
});

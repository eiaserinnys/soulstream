/** @vitest-environment jsdom */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContextContentRenderer } from "./ContextContentRenderer";

describe("ContextContentRenderer string presentation", () => {
  const content = "첫 줄 <지침>\n둘째 줄 & 복사할 본문";

  function render(fill?: boolean) {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(ContextContentRenderer, { content, fill }));
    return host.querySelector("pre")!;
  }

  it("keeps the chat presentation height-limited and preserves the text", () => {
    const pre = render();
    expect(pre.textContent).toBe(content);
    expect(pre.classList.contains("max-h-[200px]")).toBe(true);
    expect(pre.classList.contains("overflow-y-auto")).toBe(true);
    expect(pre.hasAttribute("data-slot")).toBe(false);
  });

  it("fills the available space and scrolls its own unchanged text", () => {
    const pre = render(true);
    expect(pre.textContent).toBe(content);
    expect(pre.dataset.slot).toBe("context-content-fill");
    expect(pre.classList.contains("min-h-0")).toBe(true);
    expect(pre.classList.contains("overflow-y-auto")).toBe(true);
    expect(pre.classList.contains("max-h-[200px]")).toBe(false);
  });
});

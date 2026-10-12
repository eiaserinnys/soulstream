import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatInputAccessories } from "./ChatInputAccessories";

describe("ChatInputAccessories", () => {
  it("does not reserve space when both slots are empty", () => {
    expect(renderToStaticMarkup(createElement(ChatInputAccessories))).toBe("");
  });
  it("lets the attachment area shrink while keeping its action fixed at the right", () => {
    const html = renderToStaticMarkup(createElement(ChatInputAccessories, {
      attachments: createElement("span", null, "a-long-attachment-name.pdf"),
      action: createElement("button", { type: "button" }, "되돌리기"),
    }));

    expect(html).toContain('data-slot="chat-input-accessories"');
    const row = html.match(/<div(?=[^>]*data-slot="chat-input-accessories")[^>]*>/)?.[0];
    const rowClass = row?.match(/\bclass="([^"]*)"/)?.[1];
    expect(rowClass).toContain("mb-2");
    expect(rowClass).not.toContain("pb-2");
    expect(html).toContain('data-slot="chat-input-accessories-attachments"');
    expect(html).toContain("min-w-0 flex-1");
    expect(html).toContain('data-slot="chat-input-accessories-action"');
    expect(html).toContain("ml-auto shrink-0");
    expect(html).toContain("되돌리기");
  });

  it("keeps the action in the trailing slot when there are no attachments", () => {
    const html = renderToStaticMarkup(createElement(ChatInputAccessories, {
      action: createElement("button", { type: "button" }, "되돌리기"),
    }));

    expect(html).toContain('data-slot="chat-input-accessories-action"');
    expect(html).toContain("되돌리기");
  });
});

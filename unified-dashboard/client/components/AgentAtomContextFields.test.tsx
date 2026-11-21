/** @vitest-environment jsdom */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AgentAtomContextFields } from "./AgentAtomContextFields";

it("edits folder_id as the folder condition", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  flushSync(() => root.render(createElement(AgentAtomContextFields, { context: { node_id: "test" }, index: 0, onChange, onRemove: () => {} })));
  const field = container.querySelector<HTMLInputElement>('input[aria-label="조건 · 폴더 ID"]');
  expect(field).not.toBeNull();
  expect(container.textContent).not.toContain("컨테이너 종류");
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "folder-a");
    field!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith({ node_id: "test", applies_when: { folder_id: ["folder-a"] } });
  flushSync(() => root.unmount());
  container.remove();
});

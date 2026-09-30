/** @vitest-environment jsdom */
import { createElement, type HTMLAttributes } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CardHandoff } from "./CardHandoff";

vi.mock("@seosoyoung/soul-ui", () => ({
  Button: (props: HTMLAttributes<HTMLButtonElement>) => createElement("button", props),
  Input: (props: HTMLAttributes<HTMLInputElement>) => createElement("input", props),
  Popover: ({ children }: HTMLAttributes<HTMLDivElement>) => children,
  PopoverTrigger: (props: HTMLAttributes<HTMLButtonElement>) => createElement("button", props),
  PopoverPopup: ({ children }: HTMLAttributes<HTMLDivElement>) => children,
}));
vi.mock("./AgentNodeAssignmentFields", () => ({ AgentNodeAssignmentFields: () => null }));
vi.mock("./FolderPicker", () => ({ FolderPicker: () => null }));
vi.mock("./use-folder-picker-stars", () => ({ useFolderPickerStars: () => ({ folderIds: [] }) }));
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

it("submits with Enter, and preserves Shift+Enter and Korean composition for editing", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(createElement(CardHandoff, { folders: [] })));
    const textbox = container.querySelector("textarea");
    expect(textbox, "handoff must accept multiline requests").not.toBeNull();
    const submit = vi.fn();
    textbox!.form!.requestSubmit = submit;
    const key = (options: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
      textbox!.dispatchEvent(event);
      return event;
    };
    expect(key({ shiftKey: true }).defaultPrevented).toBe(false);
    expect(key({ isComposing: true }).defaultPrevented).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(key({}).defaultPrevented).toBe(true);
    expect(submit).toHaveBeenCalledOnce();
  } finally {
    flushSync(() => root.unmount());
  }
});

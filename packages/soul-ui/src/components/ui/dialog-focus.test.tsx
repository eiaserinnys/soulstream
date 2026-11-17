/** @vitest-environment jsdom */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogPopup, DialogTitle } from "./dialog";

describe("dialog keyboard focus", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  afterEach(() => { flushSync(() => root.render(null)); vi.restoreAllMocks(); });

  function mount(onKeyDown = vi.fn()) {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 1, height: 1 }] as unknown as DOMRectList);
    flushSync(() => root.render(<Dialog open><DialogPopup showCloseButton={false} onKeyDown={onKeyDown}>
      <DialogTitle>시험</DialogTitle><button>첫째</button><button>마지막</button>
    </DialogPopup></Dialog>));
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-popup"] button')];
    return { first: buttons[0], last: buttons[1], onKeyDown };
  }

  it("wraps Tab at both ends", () => {
    const { first, last } = mount();
    last.focus();
    flushSync(() => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(first);
    flushSync(() => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(last);
  });

  it("calls the caller first and respects preventDefault", () => {
    const onKeyDown = vi.fn((event: React.KeyboardEvent) => event.preventDefault());
    const { first, last } = mount(onKeyDown);
    last.focus();
    flushSync(() => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(onKeyDown).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(last);
    expect(document.activeElement).not.toBe(first);
  });
});

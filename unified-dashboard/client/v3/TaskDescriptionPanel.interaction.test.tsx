/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskDescriptionPanel } from "./TaskDescriptionPanel";

describe("TaskDescriptionPanel daily memo interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let scrollHeight = 82;
  let scrollHeightSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    scrollHeightSpy = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
      .mockImplementation(() => scrollHeight);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    scrollHeightSpy.mockRestore();
  });

  it("fits the compact textarea to its content after every input", async () => {
    flushSync(() => root.render(
      <TaskDescriptionPanel
        markdown="첫 줄"
        onSave={vi.fn(async () => undefined)}
        ariaLabel="오늘 메모"
        variant="daily"
        initialEditing
      />,
    ));

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea!.style.height).toBe("82px");

    Object.defineProperties(textarea!, {
      offsetHeight: { configurable: true, value: 84 },
      clientHeight: { configurable: true, value: 82 },
    });
    scrollHeight = 164;
    setTextareaValue(textarea!, "첫 줄\n둘째 줄\n셋째 줄");

    await vi.waitFor(() => {
      expect(textarea!.style.height).toBe("166px");
    });
  });

  it("saves the raw markdown and returns to the rendered surface", async () => {
    const onSave = vi.fn(async () => undefined);
    flushSync(() => root.render(
      <TaskDescriptionPanel
        markdown="첫 줄"
        onSave={onSave}
        ariaLabel="오늘 메모"
        variant="daily"
        initialEditing
      />,
    ));

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    setTextareaValue(textarea!, "**원문 마크다운**");
    const save = container.querySelector<HTMLButtonElement>('button[aria-label="오늘 메모 저장"]');
    expect(save).not.toBeNull();
    save!.click();

    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("**원문 마크다운**");
      expect(container.querySelector("textarea")).toBeNull();
    });
  });
});

function setTextareaValue(target: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(target, value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

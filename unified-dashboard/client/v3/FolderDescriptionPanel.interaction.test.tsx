/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FolderDescriptionPanel } from "./FolderDescriptionPanel";

describe("FolderDescriptionPanel content-sized editor interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let scrollHeight = 82;
  let scrollHeightSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scrollHeight = 82;
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

  for (const variant of ["default", "compact", "daily", "inline"] as const) {
    it(`${variant} uses the shared CSS height bounds and scrolls after its limit`, async () => {
      const style = document.createElement("style");
      style.textContent = ".v3-description-editor textarea { min-height: 32px; max-height: 120px; border: 1px solid; }";
      document.head.append(style);
      flushSync(() => root.render(<FolderDescriptionPanel markdown="첫 줄" onSave={vi.fn(async () => undefined)}
        variant={variant} initialEditing />));
      const textarea = container.querySelector("textarea")!;
      expect(textarea.style.height).toBe("84px");
      scrollHeight = 164;
      setTextareaValue(textarea, "첫 줄\n둘째 줄\n셋째 줄");
      await vi.waitFor(() => expect(textarea.style.height).toBe("120px"));
      expect(textarea.closest('[data-slot="chat-input-composer"]')).toBeNull();
      expect(container.querySelector('button[aria-label="폴더 설명 저장"]')).not.toBeNull();
      style.remove();
    });
  }

  it("fits an empty editor when entering editing without changing the draft", () => {
    flushSync(() => root.render(<FolderDescriptionPanel markdown="" onSave={vi.fn()} />));
    flushSync(() => container.querySelector<HTMLButtonElement>(".v3-description-content")!.click());
    expect(container.querySelector<HTMLTextAreaElement>("textarea")!.style.height).not.toBe("");
  });

  it("preserves the unsaved draft after a failed blur save", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("offline"));
    flushSync(() => root.render(<FolderDescriptionPanel markdown="원래 설명" onSave={onSave} initialEditing />));
    const textarea = container.querySelector("textarea")!;
    setTextareaValue(textarea, "저장되지 않은 설명");
    textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("저장되지 않은 설명"));
    expect(container.querySelector("textarea")!.value).toBe("저장되지 않은 설명");
  });

  it("saves the raw markdown and returns to the rendered surface", async () => {
    const onSave = vi.fn(async () => undefined);
    flushSync(() => root.render(
      <FolderDescriptionPanel
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

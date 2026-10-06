/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatInputEditor } from "./ChatInputEditor";
import { PaperclipButton } from "./PaperclipButton";

describe("ChatInputEditor send button presentation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  const render = (presentation: "default" | "manuscript") => flushSync(() => root.render(
    <ChatInputEditor
      presentation={presentation}
      text=""
      onChangeText={vi.fn()}
      onSend={vi.fn()}
      placeholder=""
      buttonLabel="메시지 보내기"
      modeIcon=""
      modeLabel=""
      borderColor=""
      buttonVariant="default"
      disabled={presentation === "manuscript"}
      textareaDisabled={false}
    />,
  ));

  it("uses the bare icon cap only for manuscript and preserves its accessible label", () => {
    render("manuscript");
    const button = container.querySelector<HTMLButtonElement>('[data-testid="send-button"]');
    expect(button?.getAttribute("data-slot")).toBe("dashboard-icon-cap");
    expect(button?.className).toContain("dashboard-icon-cap--bare");
    expect(button?.getAttribute("aria-label")).toBe("메시지 보내기");
    expect(button?.title).toBe("메시지 보내기");
    expect(button?.disabled).toBe(true);
    expect(Number(button?.querySelector("svg")?.getAttribute("stroke-width"))).toBeCloseTo(1.4, 2);
    expect(button?.querySelector("svg")?.classList.contains("size-5")).toBe(true);
    expect(button?.className).toContain("disabled:text-muted-foreground");
  });

  it("keeps the standard Button and send icon in the default presentation", () => {
    render("default");
    const button = container.querySelector<HTMLButtonElement>('[data-testid="send-button"]');
    expect(button?.getAttribute("data-slot")).toBe("button");
    expect(button?.className).toContain("rounded-full");
    expect(button?.querySelector("svg")?.classList.contains("h-4")).toBe(true);
  });

  it("applies the bare small cap to the manuscript attachment button only", () => {
    flushSync(() => root.render(<PaperclipButton presentation="manuscript" onClick={vi.fn()} />));
    let button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.className).toContain("dashboard-icon-cap--bare");
    expect(button?.className).toContain("dashboard-icon-cap--small");
    expect(button?.getAttribute("aria-label")).toBe("Attach files");
    expect(button?.querySelector("svg")?.classList.contains("size-5")).toBe(true);

    flushSync(() => root.render(<PaperclipButton onClick={vi.fn()} />));
    button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.className).not.toContain("dashboard-icon-cap--bare");
    expect(button?.querySelector("svg")?.classList.contains("h-4")).toBe(true);
  });
});

/**
 * @vitest-environment jsdom
 */

import { useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TaskSectionNavigation,
  type TaskSectionRefs,
} from "./TaskSectionNavigation";

describe("TaskSectionNavigation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("tracks the section crossing the scroll activation line", async () => {
    flushSync(() => root.render(<Harness />));
    const scroll = scrollElement();
    const tops = installGeometry(scroll);

    flushSync(() => scroll.dispatchEvent(new Event("scroll")));
    await vi.waitFor(() => expect(currentLabel()).toBe("설명 섹션으로 이동"));

    tops.description = -120;
    tops.context = 180;
    flushSync(() => scroll.dispatchEvent(new Event("scroll")));
    await vi.waitFor(() => expect(currentLabel()).toBe("컨텍스트 섹션으로 이동"));

    tops.context = -80;
    tops.checklist = 175;
    flushSync(() => scroll.dispatchEvent(new Event("scroll")));
    await vi.waitFor(() => expect(currentLabel()).toBe("체크리스트 섹션으로 이동"));
  });

  it("scrolls the panel to the clicked section and marks it current", async () => {
    flushSync(() => root.render(<Harness />));
    const scroll = scrollElement();
    installGeometry(scroll);
    const scrollTo = vi.fn();
    scroll.scrollTo = scrollTo;

    const target = button("보드 섹션으로 이동");
    flushSync(() => target.click());

    expect(scrollTo).toHaveBeenCalledWith({ top: 888, behavior: "auto" });
    await vi.waitFor(() => expect(target.getAttribute("aria-current")).toBe("location"));

    scroll.scrollTop = 1000;
    flushSync(() => scroll.dispatchEvent(new Event("scroll")));
    expect(target.getAttribute("aria-current")).toBe("location");
  });

  function scrollElement(): HTMLDivElement {
    const scroll = container.querySelector<HTMLDivElement>('[data-testid="task-section-scroll"]');
    if (!scroll) throw new Error("업무 상세 스크롤을 찾지 못했습니다.");
    return scroll;
  }

  function button(label: string): HTMLButtonElement {
    const target = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.getAttribute("aria-label") === label);
    if (!target) throw new Error(`${label} 버튼을 찾지 못했습니다.`);
    return target;
  }

  function currentLabel(): string | null {
    return container.querySelector('[aria-current="location"]')?.getAttribute("aria-label") ?? null;
  }
});

function Harness() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const description = useRef<HTMLElement>(null);
  const context = useRef<HTMLElement>(null);
  const checklist = useRef<HTMLElement>(null);
  const board = useRef<HTMLElement>(null);
  const sessions = useRef<HTMLElement>(null);
  const sectionRefs: TaskSectionRefs = { description, context, checklist, board, sessions };

  return (
    <div ref={scrollRef} data-testid="task-section-scroll">
      <TaskSectionNavigation scrollRef={scrollRef} sectionRefs={sectionRefs} />
      <section ref={description} data-section-id="description" />
      <section ref={context} data-section-id="context" />
      <section ref={checklist} data-section-id="checklist" />
      <section ref={board} data-section-id="board" />
      <section ref={sessions} data-section-id="sessions" />
    </div>
  );
}

function installGeometry(scroll: HTMLDivElement) {
  const tops = {
    description: 120,
    context: 360,
    checklist: 660,
    board: 800,
    sessions: 1120,
  };
  Object.defineProperties(scroll, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: 1600 },
    scrollTop: { configurable: true, writable: true, value: 200 },
  });
  scroll.getBoundingClientRect = () => rect(100);
  for (const [id, top] of Object.entries(tops)) {
    const section = scroll.querySelector<HTMLElement>(`[data-section-id="${id}"]`);
    if (!section) throw new Error(`${id} 섹션을 찾지 못했습니다.`);
    section.getBoundingClientRect = () => rect(tops[id as keyof typeof tops]);
  }
  return tops;
}

function rect(top: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 100,
    bottom: top + 100,
    left: 0,
    width: 100,
    height: 100,
    toJSON: () => ({}),
  } as DOMRect;
}

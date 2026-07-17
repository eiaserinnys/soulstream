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
    await vi.waitFor(() => expect(currentLabel()).toBe("정보 섹션으로 이동"));

    tops.information = -120;
    tops.checklist = 180;
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

  it("uses the same section scroll path to focus an externally requested session row", async () => {
    flushSync(() => root.render(<Harness />));
    const scroll = scrollElement();
    installGeometry(scroll);
    const scrollTo = vi.fn();
    const onFocusRequestHandled = vi.fn();
    scroll.scrollTo = scrollTo;

    flushSync(() => root.render(
      <Harness
        focusRequest={{ requestId: 1, sectionId: "sessions", sessionId: "session-target" }}
        onFocusRequestHandled={onFocusRequestHandled}
      />,
    ));

    expect(scrollTo).toHaveBeenCalledWith({ top: 1068, behavior: "auto" });
    expect(onFocusRequestHandled).toHaveBeenCalledWith(1);
    await vi.waitFor(() => expect(currentLabel()).toBe("세션 섹션으로 이동"));
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

function Harness({
  focusRequest,
  onFocusRequestHandled,
}: {
  focusRequest?: { requestId: number; sectionId: "sessions"; sessionId: string };
  onFocusRequestHandled?(requestId: number): void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const information = useRef<HTMLElement>(null);
  const checklist = useRef<HTMLElement>(null);
  const board = useRef<HTMLElement>(null);
  const sessions = useRef<HTMLElement>(null);
  const sectionRefs: TaskSectionRefs = { information, checklist, board, sessions };

  return (
    <div ref={scrollRef} data-testid="task-section-scroll">
      <TaskSectionNavigation
        scrollRef={scrollRef}
        sectionRefs={sectionRefs}
        focusRequest={focusRequest}
        focusTargetReady
        onFocusRequestHandled={onFocusRequestHandled}
      />
      <section ref={information} data-section-id="information" />
      <section ref={checklist} data-section-id="checklist" />
      <section ref={board} data-section-id="board" />
      <section ref={sessions} data-section-id="sessions">
        <div data-session-id="session-target" />
      </section>
    </div>
  );
}

function installGeometry(scroll: HTMLDivElement) {
  const tops = {
    information: 120,
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
  const sessionTarget = scroll.querySelector<HTMLElement>('[data-session-id="session-target"]');
  if (!sessionTarget) throw new Error("세션 포커스 대상을 찾지 못했습니다.");
  sessionTarget.getBoundingClientRect = () => rect(980);
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

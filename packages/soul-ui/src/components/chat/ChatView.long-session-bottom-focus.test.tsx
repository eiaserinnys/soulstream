/**
 * @vitest-environment jsdom
 */

import { createElement, type ComponentType } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoulSSEEvent } from "@shared/types";

import { useDashboardStore } from "../../stores/dashboard-store";
import { ChatView } from "./ChatView";

const virtuosoMock = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  requestOlder: vi.fn(),
  notifyViewportGeometry: vi.fn(),
  blockedReason: null as "cap" | "error" | null,
  canLoadOlder: false,
  props: null as Record<string, unknown> | null,
}));

vi.mock("react-virtuoso", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  const Virtuoso = React.forwardRef<unknown, Record<string, unknown>>((props, ref) => {
    const scrollerRef = React.useRef<HTMLDivElement>(null);
    virtuosoMock.props = props;
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: virtuosoMock.scrollToIndex,
      scrollBy: vi.fn(),
      scrollTo: vi.fn(),
      getState: vi.fn(),
      autoscrollToBottom: vi.fn(),
      scrollIntoView: vi.fn(),
    }));
    React.useEffect(() => {
      virtuosoMock.props = props;
      const setScrollerRef = props.scrollerRef as
        | ((ref: HTMLDivElement | null) => void)
        | undefined;
      setScrollerRef?.(scrollerRef.current);
      return () => {
        setScrollerRef?.(null);
      };
    }, [props.scrollerRef]);

    const data = (props.data as any[] | undefined) ?? [];
    const components = props.components as
      | { Header?: ComponentType; EmptyPlaceholder?: ComponentType }
      | undefined;
    const Header = components?.Header;
    const EmptyPlaceholder = components?.EmptyPlaceholder;
    const firstItemIndex = props.firstItemIndex as number;
    const computeItemKey = props.computeItemKey as (
      index: number,
      item: any,
    ) => React.Key;
    const itemContent = props.itemContent as (index: number, item: any) => React.ReactNode;
    return React.createElement(
      "div",
      { ref: scrollerRef, "data-testid": "virtuoso" },
      Header ? React.createElement(Header) : null,
      data.length === 0 && EmptyPlaceholder
        ? React.createElement(EmptyPlaceholder)
        : null,
      data.map((item, index) => React.createElement(
        "div",
        { key: computeItemKey(firstItemIndex + index, item) },
        itemContent(firstItemIndex + index, item),
      )),
    );
  });

  return { Virtuoso };
});

vi.mock("./useMessageHistoryBuffer", () => ({
  useMessageHistoryBuffer: () => ({
    loading: false,
    reachedTop: false,
    canLoadOlder: virtuosoMock.canLoadOlder,
    blockedReason: virtuosoMock.blockedReason,
    requestOlder: virtuosoMock.requestOlder,
    notifyViewportGeometry: virtuosoMock.notifyViewportGeometry,
  }),
}));

vi.mock("../ChatInput", () => ({
  ChatInput: () => createElement("div", { "data-testid": "chat-input" }),
}));

vi.mock("./VirtualizedItem", () => ({
  VirtualizedItem: () => createElement("div", { "data-testid": "chat-item" }),
}));

vi.mock("./hooks", () => ({
  useLlmContext: () => undefined,
}));

vi.mock("./ChatRuntimeCompactStrips", () => ({
  ChatRuntimeCompactStrips: () =>
    createElement("div", { "data-testid": "runtime-strips" }),
}));

function makeUserMessage(eventId: number): { event: SoulSSEEvent; eventId: number } {
  return {
    event: {
      type: "user_message",
      text: `message-${eventId}`,
      timestamp: 0,
    } as unknown as SoulSSEEvent,
    eventId,
  };
}

function makeAssistantMessage(eventId: number): { event: SoulSSEEvent; eventId: number } {
  return {
    event: {
      type: "assistant_message",
      text: `assistant-${eventId}`,
      timestamp: 0,
    } as unknown as SoulSSEEvent,
    eventId,
  };
}

function makeComplete(eventId: number): { event: SoulSSEEvent; eventId: number } {
  return {
    event: {
      type: "complete",
      timestamp: 0,
    } as unknown as SoulSSEEvent,
    eventId,
  };
}

function makeTurnSummary(
  eventId: number,
  anchorEventId: number,
): { event: SoulSSEEvent; eventId: number } {
  return {
    event: {
      type: "turn_summary",
      content: `summary-${eventId}`,
      final_response_event_id: anchorEventId,
      parent_event_id: anchorEventId,
      timestamp: 0,
    } as unknown as SoulSSEEvent,
    eventId,
  };
}

function virtuosoData(): any[] {
  return (virtuosoMock.props?.data as any[] | undefined) ?? [];
}

function itemKeyAt(dataIndex: number): React.Key {
  const data = virtuosoData();
  const firstItemIndex = virtuosoMock.props?.firstItemIndex as number;
  const computeItemKey = virtuosoMock.props?.computeItemKey as (
    index: number,
    item: any,
  ) => React.Key;
  return computeItemKey(firstItemIndex + dataIndex, data[dataIndex]);
}

function setFirstVisibleDataIndex(dataIndex: number): {
  absoluteIndex: number;
  key: React.Key;
} {
  const firstItemIndex = virtuosoMock.props?.firstItemIndex as number;
  const absoluteIndex = firstItemIndex + dataIndex;
  const key = itemKeyAt(dataIndex);
  const scroller = document.querySelector<HTMLElement>('[data-testid="virtuoso"]');
  if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
  const makeRect = (top: number, bottom: number): DOMRect => ({
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: 320,
    width: 320,
    height: bottom - top,
    toJSON: () => ({}),
  });
  scroller.getBoundingClientRect = () => makeRect(100, 300);
  const markers = Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-chat-item-key]"),
  );
  markers.forEach((marker, index) => {
    const row = marker.firstElementChild as HTMLElement | null;
    if (!row) throw new Error("chat item geometry target이 없습니다.");
    const top = 100 + (index - dataIndex) * 40;
    row.getBoundingClientRect = () => makeRect(top, top + 40);
  });
  scroller.dispatchEvent(new Event("scroll"));
  expect(scroller.dataset.chatFirstVisibleKey).toBe(String(key));
  return { absoluteIndex, key };
}

function findDataIndexByKey(key: React.Key): number {
  return virtuosoData().findIndex((_, index) => itemKeyAt(index) === key);
}

function flushPassiveEffects(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

async function renderChatView(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(createElement(ChatView));
  });
  await flushPassiveEffects();

  return { container, root };
}

function markOlderExploration(container: HTMLElement | undefined): void {
  if (!container) throw new Error("ChatView test container가 없습니다.");
  const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
  if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    writable: true,
    value: 120,
  });
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
}

describe("ChatView long-session initial bottom focus", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let now = 0;

  beforeEach(() => {
    now = 0;
    useDashboardStore.getState().reset();
    useDashboardStore.getState().setActiveSession("sess-long");
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    virtuosoMock.scrollToIndex.mockClear();
    virtuosoMock.requestOlder.mockClear();
    virtuosoMock.notifyViewportGeometry.mockClear();
    virtuosoMock.blockedReason = null;
    virtuosoMock.canLoadOlder = false;
    virtuosoMock.props = null;
  });

  afterEach(async () => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
      await flushPassiveEffects();
    }
    container?.remove();
    root = undefined;
    container = undefined;
    useDashboardStore.getState().reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps retrying bottom focus after a late false atBottom report until the session reaches bottom", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeUserMessage(1000),
      makeUserMessage(1001),
    ]);

    ({ container, root } = await renderChatView());
    expect(container.querySelector('[data-testid="virtuoso"]')).not.toBeNull();
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
      behavior: "auto",
    });

    flushSync(() => {
      const atBottomStateChange = virtuosoMock.props?.atBottomStateChange as
        | ((atBottom: boolean) => void)
        | undefined;
      atBottomStateChange?.(true);
    });
    await flushPassiveEffects();

    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 800 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    virtuosoMock.scrollToIndex.mockClear();
    now = 1000;
    flushSync(() => {
      const atBottomStateChange = virtuosoMock.props?.atBottomStateChange as
        | ((atBottom: boolean) => void)
        | undefined;
      atBottomStateChange?.(false);
    });
    await flushPassiveEffects();
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
      behavior: "auto",
    });

    virtuosoMock.scrollToIndex.mockClear();
    now = 1001;
    flushSync(() => {
      useDashboardStore.getState().processHistoryEvents([
        makeUserMessage(900),
        makeUserMessage(901),
      ]);
    });
    await flushPassiveEffects();

    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
      behavior: "auto",
    });
  });

  it("빈 viewport를 먼저 mount하지 않고 첫 visible page의 최종 좌표로 시작한다", async () => {
    ({ container, root } = await renderChatView());
    expect(container.querySelector('[data-testid="virtuoso"]')).toBeNull();

    flushSync(() => {
      useDashboardStore.getState().processHistoryEvents([
        makeUserMessage(1000),
        makeUserMessage(1001),
      ]);
    });
    await flushPassiveEffects();

    expect(container.querySelector('[data-testid="virtuoso"]')).not.toBeNull();
    expect(virtuosoData()).toHaveLength(2);
    expect(virtuosoMock.props?.firstItemIndex).toBe(9_998);
    expect(virtuosoMock.props?.initialTopMostItemIndex).toEqual({
      index: 1,
      align: "end",
    });
  });

  it("초기 정착 중 명시적 위스크롤은 뒤 history commit의 bottom 이동을 취소한다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    virtuosoMock.scrollToIndex.mockClear();

    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    scroller?.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void) | undefined)?.(false);
    flushSync(() => {
      useDashboardStore.getState().processHistoryEvents([makeUserMessage(900)]);
    });
    await flushPassiveEffects();

    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("follow-off에서 first visible 앞의 live 과거 summary를 anchor stable row 안에 결합한다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeAssistantMessage(1000),
      makeComplete(1001),
      makeUserMessage(1100),
    ]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    virtuosoMock.scrollToIndex.mockClear();

    flushSync(() => {
      markOlderExploration(container);
    });
    await flushPassiveEffects();
    const completeIndex = virtuosoData().findIndex(
      (item) => item.type === "single" && item.msg.treeNodeType === "complete",
    );
    const before = setFirstVisibleDataIndex(completeIndex);
    const beforeFirstItemIndex = virtuosoMock.props?.firstItemIndex as number;

    flushSync(() => {
      useDashboardStore.getState().processEvent(makeTurnSummary(1200, 1000).event, 1200);
    });
    await flushPassiveEffects();

    const afterIndex = findDataIndexByKey(before.key);
    const afterFirstItemIndex = virtuosoMock.props?.firstItemIndex as number;
    expect(afterIndex).toBe(completeIndex);
    expect(afterFirstItemIndex).toBe(beforeFirstItemIndex);
    expect(afterFirstItemIndex + afterIndex).toBe(before.absoluteIndex);
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("first visible 뒤의 live summary는 firstItemIndex를 바꾸지 않는다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeAssistantMessage(1000),
      makeComplete(1001),
      makeUserMessage(1100),
    ]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    virtuosoMock.scrollToIndex.mockClear();
    flushSync(() => {
      markOlderExploration(container);
    });
    await flushPassiveEffects();
    const before = setFirstVisibleDataIndex(0);
    const beforeFirstItemIndex = virtuosoMock.props?.firstItemIndex as number;

    flushSync(() => {
      useDashboardStore.getState().processEvent(makeTurnSummary(1200, 1000).event, 1200);
    });
    await flushPassiveEffects();

    expect(findDataIndexByKey(before.key)).toBe(0);
    expect(virtuosoMock.props?.firstItemIndex).toBe(beforeFirstItemIndex);
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("미로딩 anchor summary는 data와 firstItemIndex를 바꾸지 않는다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1100)]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    virtuosoMock.scrollToIndex.mockClear();
    flushSync(() => {
      markOlderExploration(container);
    });
    await flushPassiveEffects();
    const before = setFirstVisibleDataIndex(0);
    const beforeFirstItemIndex = virtuosoMock.props?.firstItemIndex as number;
    const beforeLength = virtuosoData().length;

    flushSync(() => {
      useDashboardStore.getState().processEvent(makeTurnSummary(1200, 1000).event, 1200);
    });
    await flushPassiveEffects();

    expect(virtuosoData()).toHaveLength(beforeLength);
    expect(itemKeyAt(0)).toBe(before.key);
    expect(virtuosoMock.props?.firstItemIndex).toBe(beforeFirstItemIndex);
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("미로딩 summary의 anchor prepend는 history count만으로 visible 절대 좌표를 보존한다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeUserMessage(1100),
      makeTurnSummary(1200, 1000),
    ]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    virtuosoMock.scrollToIndex.mockClear();
    flushSync(() => {
      markOlderExploration(container);
    });
    await flushPassiveEffects();
    const before = setFirstVisibleDataIndex(0);
    const beforePrependedCount = useDashboardStore.getState().chatPrependedCount;

    now = 1100;
    flushSync(() => {
      useDashboardStore.getState().processHistoryEvents([
        makeAssistantMessage(1000),
        makeComplete(1001),
      ]);
    });
    await flushPassiveEffects();

    const afterIndex = findDataIndexByKey(before.key);
    const added = useDashboardStore.getState().chatPrependedCount - beforePrependedCount;
    expect(added).toBe(2);
    expect(afterIndex).toBe(2);
    expect((virtuosoMock.props?.firstItemIndex as number) + afterIndex).toBe(
      before.absoluteIndex,
    );
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("bottom의 live summary는 bottom을 유지하고 미로딩 summary는 scroll을 일으키지 않는다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeAssistantMessage(1000),
      makeComplete(1001),
      makeUserMessage(1100),
    ]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    virtuosoMock.scrollToIndex.mockClear();

    flushSync(() => {
      useDashboardStore.getState().processEvent(makeTurnSummary(1200, 999).event, 1200);
    });
    await flushPassiveEffects();
    expect(virtuosoData()).toHaveLength(3);
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();

    flushSync(() => {
      useDashboardStore.getState().processEvent(makeTurnSummary(1201, 1000).event, 1201);
    });
    await flushPassiveEffects();
    expect(virtuosoData()).toHaveLength(3);
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
      behavior: "auto",
    });
  });

  it("stable key와 행 수가 같은 streaming delta도 bottom follow를 유지한다", async () => {
    useDashboardStore.getState().processEvent(
      {
        type: "text_start",
        parent_event_id: "0",
        timestamp: 0,
      } as unknown as SoulSSEEvent,
      1000,
    );
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    const beforeLength = virtuosoData().length;
    const beforeKey = itemKeyAt(0);
    virtuosoMock.scrollToIndex.mockClear();

    flushSync(() => {
      useDashboardStore.getState().processEvent(
        {
          type: "text_delta",
          text: "streaming content grew",
          timestamp: 1,
        } as unknown as SoulSSEEvent,
        1001,
      );
    });
    await flushPassiveEffects();

    expect(virtuosoData()).toHaveLength(beforeLength);
    expect(itemKeyAt(0)).toBe(beforeKey);
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
      behavior: "auto",
    });
  });

  it("duplicate reconnect와 reload는 stable key·순서·follow-off 좌표를 바꾸지 않는다", async () => {
    const history = [
      makeAssistantMessage(1000),
      makeComplete(1001),
      makeUserMessage(1100),
      makeTurnSummary(1200, 1000),
    ];
    useDashboardStore.getState().processHistoryEvents(history);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    flushSync(() => {
      markOlderExploration(container);
    });
    await flushPassiveEffects();
    const visible = setFirstVisibleDataIndex(2);
    const beforeKeys = virtuosoData().map((_, index) => itemKeyAt(index));
    const beforeFirstItemIndex = virtuosoMock.props?.firstItemIndex;
    virtuosoMock.scrollToIndex.mockClear();

    flushSync(() => {
      useDashboardStore.getState().processEvent(history[3].event, history[3].eventId);
      useDashboardStore.getState().processHistoryEvents(history);
    });
    await flushPassiveEffects();

    expect(virtuosoData().map((_, index) => itemKeyAt(index))).toEqual(beforeKeys);
    expect(findDataIndexByKey(visible.key)).toBe(2);
    expect(virtuosoMock.props?.firstItemIndex).toBe(beforeFirstItemIndex);
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("자동 reconnect는 같은 세션의 live 논리 삽입 보정을 유지한다", async () => {
    const history = [
      makeAssistantMessage(1000),
      makeComplete(1001),
      makeUserMessage(1100),
    ];
    useDashboardStore.getState().processHistoryEvents(history);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    flushSync(() => {
      markOlderExploration(container);
    });
    await flushPassiveEffects();
    const completeIndex = virtuosoData().findIndex(
      (item) => item.type === "single" && item.msg.treeNodeType === "complete",
    );
    const visible = setFirstVisibleDataIndex(completeIndex);
    flushSync(() => {
      useDashboardStore.getState().processEvent(makeTurnSummary(1200, 1000).event, 1200);
    });
    await flushPassiveEffects();
    const correctedFirstItemIndex = virtuosoMock.props?.firstItemIndex;
    virtuosoMock.scrollToIndex.mockClear();

    flushSync(() => {
      useDashboardStore.getState().processHistoryEvents([
        ...history,
        makeTurnSummary(1200, 1000),
      ]);
    });
    await flushPassiveEffects();

    expect(virtuosoMock.props?.firstItemIndex).toBe(correctedFirstItemIndex);
    expect(findDataIndexByKey(visible.key)).toBe(completeIndex);
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("수동 clearTree 뒤 같은 세션 reconnect는 이전 논리 삽입 보정을 버린다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeAssistantMessage(1000),
      makeComplete(1001),
      makeUserMessage(1100),
    ]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    flushSync(() => {
      markOlderExploration(container);
    });
    await flushPassiveEffects();
    const completeIndex = virtuosoData().findIndex(
      (item) => item.type === "single" && item.msg.treeNodeType === "complete",
    );
    setFirstVisibleDataIndex(completeIndex);
    flushSync(() => {
      useDashboardStore.getState().processEvent(makeTurnSummary(1200, 1000).event, 1200);
    });
    await flushPassiveEffects();

    flushSync(() => {
      useDashboardStore.getState().clearTree();
    });
    expect(useDashboardStore.getState().tree).toBeNull();
    // clearTree의 empty-data 렌더를 지난 뒤 같은 ChatView instance에 reconnect한다.
    // 빈 상태에서는 Virtuoso가 unmount되므로 remount 좌표가 훅 reset의 증거다.
    flushSync(() => {
      root?.render(createElement(ChatView));
    });
    await flushPassiveEffects();

    flushSync(() => {
      useDashboardStore.getState().processHistoryEvents([
        makeAssistantMessage(2000),
        makeComplete(2001),
        makeUserMessage(2100),
      ]);
    });
    await flushPassiveEffects();

    const prependedCount = useDashboardStore.getState().chatPrependedCount;
    expect(virtuosoMock.props?.firstItemIndex).toBe(10_000 - prependedCount);
    expect(virtuosoData().map((_, index) => itemKeyAt(index))).toEqual([
      "asst-msg-2000",
      "complete-2001",
      "user-msg-2100",
    ]);
  });

  it("session switch는 이전 세션의 논리 삽입 보정과 key를 재사용하지 않는다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeAssistantMessage(1000),
      makeComplete(1001),
      makeUserMessage(1100),
    ]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    flushSync(() => {
      markOlderExploration(container);
    });
    await flushPassiveEffects();
    setFirstVisibleDataIndex(1);
    flushSync(() => {
      useDashboardStore.getState().processEvent(makeTurnSummary(1200, 1000).event, 1200);
    });
    await flushPassiveEffects();
    expect(virtuosoMock.props?.firstItemIndex).toBe(9_997);

    flushSync(() => {
      useDashboardStore.getState().setActiveSession("sess-other");
      useDashboardStore.getState().processHistoryEvents([makeUserMessage(2000)]);
    });
    await flushPassiveEffects();

    expect(virtuosoMock.props?.firstItemIndex).toBe(9_999);
    expect(virtuosoData().map((_, index) => itemKeyAt(index))).toEqual([
      "user-msg-2000",
    ]);
  });

  it.each([
    ["error", "0행", false],
    ["error", "1행", true],
    ["cap", "0행", false],
    ["cap", "1행", true],
  ] as const)("%s %s 상태에 이전 대화 수동 재시도 어포던스를 노출한다", async (reason, _label, withRow) => {
    virtuosoMock.blockedReason = reason;
    if (withRow) {
      useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    }

    ({ container, root } = await renderChatView());
    const virtuoso = container.querySelector('[data-testid="virtuoso"]');
    if (withRow) expect(virtuoso).not.toBeNull();
    else expect(virtuoso).toBeNull();
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("이전 대화 더 불러오기"),
    );
    expect(button).toBeDefined();

    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("manual");
  });

  it("0행·추가 cursor에는 명시적인 이전 대화 기본 경로를 노출한다", async () => {
    virtuosoMock.canLoadOlder = true;
    ({ container, root } = await renderChatView());

    expect(container.querySelector('[data-testid="virtuoso"]')).toBeNull();
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("이전 대화 더 불러오기"),
    );
    expect(button).toBeDefined();

    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("manual");
  });

  it("0행에는 Virtuoso를 mount하지 않고 Waiting 상태를 표시한다", async () => {
    ({ container, root } = await renderChatView());

    expect(container.querySelector('[data-testid="virtuoso"]')).toBeNull();
    expect(container.textContent).toContain("Waiting for events...");
    expect(virtuosoMock.notifyViewportGeometry).toHaveBeenCalled();
  });

  it("mount-time startReached·geometry는 fetch하지 않고 실제 위스크롤만 controller를 연다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    expect(virtuosoMock.notifyViewportGeometry).toHaveBeenCalled();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 800 });
    const nativeScrollTo = vi.fn();
    scroller.scrollTo = nativeScrollTo;

    virtuosoMock.notifyViewportGeometry.mockClear();
    virtuosoMock.scrollToIndex.mockClear();
    (virtuosoMock.props?.itemsRendered as (() => void) | undefined)?.();
    (virtuosoMock.props?.totalListHeightChanged as (() => void) | undefined)?.();
    expect(virtuosoMock.notifyViewportGeometry).toHaveBeenCalledTimes(2);
    expect(nativeScrollTo).toHaveBeenCalledWith({ top: 800, behavior: "auto" });
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();

    (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void) | undefined)?.(true);
    (virtuosoMock.props?.startReached as (() => void) | undefined)?.();
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();

    scroller.dispatchEvent(new Event("scroll"));
    (virtuosoMock.props?.startReached as (() => void) | undefined)?.();
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();

    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("automatic");
    nativeScrollTo.mockClear();
    (virtuosoMock.props?.totalListHeightChanged as (() => void) | undefined)?.();
    expect(nativeScrollTo).not.toHaveBeenCalled();
  });

  it("스크롤바의 실제 위쪽 이동만 탐색 의도로 인정한다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    virtuosoMock.requestOlder.mockClear();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 120,
    });

    scroller.dispatchEvent(new Event("scroll"));
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();

    scroller.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("automatic");
  });

  it("같은 세션에서 scroller가 unmount되면 남아 있던 위쪽 탐색 의도를 버린다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    virtuosoMock.requestOlder.mockClear();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 120,
    });

    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();

    const setScrollerRef = virtuosoMock.props?.scrollerRef as
      | ((ref: HTMLDivElement | null) => void)
      | undefined;
    setScrollerRef?.(null);
    (virtuosoMock.props?.startReached as (() => void) | undefined)?.();

    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();
  });

  it("Follow를 다시 켜면 남아 있던 위쪽 탐색 의도를 버린다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    virtuosoMock.requestOlder.mockClear();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 120,
    });

    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();
    const followButton = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("Follow"),
    );
    flushSync(() => {
      followButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushPassiveEffects();

    scroller.scrollTop = 0;
    (virtuosoMock.props?.startReached as (() => void) | undefined)?.();
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();
    expect(
      (virtuosoMock.props?.followOutput as (() => "auto" | false) | undefined)?.(),
    ).toBe("auto");
  });

  it("자식 control의 키와 pointer 입력을 history 탐색으로 오인하지 않는다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    virtuosoMock.requestOlder.mockClear();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 120,
    });
    const button = document.createElement("button");
    scroller.appendChild(button);

    button.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "Home",
    }));
    button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));

    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();
    expect(
      (virtuosoMock.props?.followOutput as (() => "auto" | false) | undefined)?.(),
    ).toBe("auto");
  });

  it("위쪽 입력을 소비할 수 있는 중첩 scroller를 outer history 탐색으로 오인하지 않는다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    virtuosoMock.requestOlder.mockClear();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    const nestedScroller = document.createElement("div");
    nestedScroller.style.overflowY = "auto";
    Object.defineProperty(nestedScroller, "scrollHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(nestedScroller, "clientHeight", {
      configurable: true,
      value: 100,
    });
    Object.defineProperty(nestedScroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 50,
    });
    const nestedContent = document.createElement("div");
    nestedScroller.appendChild(nestedContent);
    scroller.appendChild(nestedScroller);

    nestedContent.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      deltaY: -40,
    }));
    const touchStart = new Event("touchstart", { bubbles: true });
    const touchMove = new Event("touchmove", { bubbles: true });
    Object.defineProperty(touchStart, "touches", { value: [{ clientY: 100 }] });
    Object.defineProperty(touchMove, "touches", { value: [{ clientY: 120 }] });
    nestedContent.dispatchEvent(touchStart);
    nestedContent.dispatchEvent(touchMove);

    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();
    expect(
      (virtuosoMock.props?.followOutput as (() => "auto" | false) | undefined)?.(),
    ).toBe("auto");

    nestedScroller.scrollTop = 0;
    nestedContent.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      deltaY: -40,
    }));
    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("automatic");
  });

  it.each(["ArrowUp", "PageUp", "Home"])(
    "%s 키의 위쪽 탐색 의도로 이전 대화를 요청한다",
    async (key) => {
      useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
      ({ container, root } = await renderChatView());
      virtuosoMock.requestOlder.mockClear();
      const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');

      scroller?.dispatchEvent(new KeyboardEvent("keydown", { key }));

      expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("automatic");
    },
  );

  it("아래로 끄는 touch 탐색 의도로 이전 대화를 요청한다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    virtuosoMock.requestOlder.mockClear();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    const touchStart = new Event("touchstart");
    const touchMove = new Event("touchmove");
    Object.defineProperty(touchStart, "touches", { value: [{ clientY: 100 }] });
    Object.defineProperty(touchMove, "touches", { value: [{ clientY: 120 }] });

    scroller?.dispatchEvent(touchStart);
    scroller?.dispatchEvent(touchMove);

    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("automatic");
  });

  it("검색 focus 이동은 follow와 bottom 보정을 끄고 과거 행에 머문다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeUserMessage(1000),
      makeAssistantMessage(1001),
      makeUserMessage(1002),
    ]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    virtuosoMock.scrollToIndex.mockClear();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 800 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 400,
    });
    const nativeScrollTo = vi.fn();
    scroller.scrollTo = nativeScrollTo;
    const targetDataIndex = findDataIndexByKey("user-msg-1000");
    const firstItemIndex = virtuosoMock.props?.firstItemIndex as number;

    flushSync(() => {
      useDashboardStore.getState().setFocusEventId(1000);
    });
    await flushPassiveEffects();

    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({
      index: firstItemIndex + targetDataIndex,
      align: "center",
    });
    expect(
      (virtuosoMock.props?.followOutput as (() => "auto" | false) | undefined)?.(),
    ).toBe(false);

    (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void) | undefined)?.(false);
    (virtuosoMock.props?.itemsRendered as (() => void) | undefined)?.();
    (virtuosoMock.props?.totalListHeightChanged as (() => void) | undefined)?.();

    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(nativeScrollTo).not.toHaveBeenCalled();
  });

  it("검색 focus 이동은 아직 소비되지 않은 history 탐색 의도를 취소한다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeUserMessage(1000),
      makeAssistantMessage(1001),
      makeUserMessage(1002),
    ]);
    ({ container, root } = await renderChatView());
    virtuosoMock.requestOlder.mockClear();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 120,
    });

    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();
    flushSync(() => {
      useDashboardStore.getState().setFocusEventId(1000);
    });
    await flushPassiveEffects();

    scroller.scrollTop = 0;
    (virtuosoMock.props?.startReached as (() => void) | undefined)?.();
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();
  });
});

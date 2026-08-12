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
    }, [props]);

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

    virtuosoMock.scrollToIndex.mockClear();
    now = 1000;
    flushSync(() => {
      const atBottomStateChange = virtuosoMock.props?.atBottomStateChange as
        | ((atBottom: boolean) => void)
        | undefined;
      atBottomStateChange?.(false);
    });
    await flushPassiveEffects();

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

    now = 1000;
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(false);
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
    now = 1000;
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(false);
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
    now = 1000;
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(false);
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
    now = 1000;
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(false);
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
    now = 1000;
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(false);
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
    now = 1000;
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(false);
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
    now = 1000;
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(false);
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
    now = 1000;
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(false);
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
    expect(container.querySelector('[data-testid="virtuoso"]')).not.toBeNull();
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("이전 대화 더 불러오기"),
    );
    expect(button).toBeDefined();

    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("manual");
  });

  it("0행에도 scroller와 Waiting placeholder를 유지해 geometry controller를 깨운다", async () => {
    ({ container, root } = await renderChatView());

    expect(container.querySelector('[data-testid="virtuoso"]')).not.toBeNull();
    expect(container.textContent).toContain("Waiting for events...");
    expect(virtuosoMock.notifyViewportGeometry).toHaveBeenCalled();
  });

  it("scroller bind·commit·height 변화와 startReached를 단일 history controller에 연결한다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    expect(virtuosoMock.notifyViewportGeometry).toHaveBeenCalled();

    virtuosoMock.notifyViewportGeometry.mockClear();
    (virtuosoMock.props?.itemsRendered as (() => void) | undefined)?.();
    (virtuosoMock.props?.totalListHeightChanged as (() => void) | undefined)?.();
    expect(virtuosoMock.notifyViewportGeometry).toHaveBeenCalledTimes(2);

    (virtuosoMock.props?.startReached as (() => void) | undefined)?.();
    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("automatic");
  });
});

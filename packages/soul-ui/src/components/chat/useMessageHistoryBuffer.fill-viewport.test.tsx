/**
 * @vitest-environment jsdom
 */

import { act, createElement, useEffect, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flattenTree } from "../../lib/flatten-tree";
import { groupMessages } from "../../lib/grouping";
import { useDashboardStore } from "../../stores/dashboard-store";
import {
  MAX_VIEWPORT_FILL_PAGES,
  useMessageHistoryBuffer,
  type UseMessageHistoryBufferResult,
} from "./useMessageHistoryBuffer";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function timelineMessage(
  id: number,
  eventType: "tool_start" | "user_message" | "result" = "user_message",
) {
  return {
    id,
    parent_event_id: null,
    event_type: eventType,
    payload: eventType === "tool_start"
      ? {
          type: eventType,
          tool_use_id: `tool-${id}`,
          tool_name: "Read",
          tool_input: { file_path: `/tmp/${id}` },
          timestamp: id,
        }
      : eventType === "result"
        ? { type: eventType, output: `state-${id}`, timestamp: id }
        : { type: eventType, text: `message-${id}`, timestamp: id },
    created_at: new Date(id * 1_000).toISOString(),
  };
}

function page(
  ids: number[],
  nextCursor: string | null,
  eventType: "tool_start" | "user_message" | "result" = "user_message",
): Response {
  return new Response(JSON.stringify({
    messages: ids.map((id) => timelineMessage(id, eventType)),
    next_cursor: nextCursor,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function setGeometry(
  scroller: HTMLElement,
  geometry: { clientHeight: number; scrollHeight: number },
): void {
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: geometry.clientHeight },
    scrollHeight: { configurable: true, value: geometry.scrollHeight },
  });
}

let latest: UseMessageHistoryBufferResult | null = null;
const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function Harness({
  sessionId,
  scrollerRef,
}: {
  sessionId: string;
  scrollerRef: RefObject<HTMLElement | null>;
}) {
  const result = useMessageHistoryBuffer(sessionId, scrollerRef);
  useEffect(() => {
    latest = result;
  }, [result]);
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function notifyGeometry(): Promise<void> {
  await act(async () => {
    latest?.notifyViewportGeometry();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function requestOlder(source: "automatic" | "manual"): Promise<void> {
  await act(async () => {
    latest?.requestOlder(source);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useMessageHistoryBuffer bounded viewport fill", () => {
  let root: Root;
  let container: HTMLDivElement;
  let scroller: HTMLDivElement;
  let scrollerRef: RefObject<HTMLElement | null>;

  async function renderSession(sessionId: string): Promise<void> {
    useDashboardStore.getState().setActiveSession(sessionId);
    await act(async () => {
      root.render(createElement(Harness, { sessionId, scrollerRef }));
    });
    await flush();
  }

  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    useDashboardStore.getState().reset();
    latest = null;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    scroller = document.createElement("div");
    setGeometry(scroller, { clientHeight: 600, scrollHeight: 100 });
    scrollerRef = { current: scroller };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useDashboardStore.getState().reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("연속 tool 100개가 한 화면 행으로 접혀도 commit geometry가 부족하면 다음 page를 자동 요청한다", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page(
        Array.from({ length: 100 }, (_, index) => 200 - index),
        "cursor-1",
        "tool_start",
      ))
      .mockResolvedValueOnce(page([99], "cursor-2"));
    vi.stubGlobal("fetch", fetchMock);

    await renderSession("sess-tools");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const messages = flattenTree(useDashboardStore.getState().tree);
    expect(messages).toHaveLength(100);
    expect(groupMessages(messages)).toHaveLength(1);

    await notifyGeometry();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("state-only page가 0행을 만든 뒤 늦게 scroller가 bind되면 다음 page로 진행한다", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page([2], "cursor-1", "result"))
      .mockResolvedValueOnce(page([1], null));
    vi.stubGlobal("fetch", fetchMock);
    scrollerRef = { current: null };

    await renderSession("sess-state-only");
    expect(flattenTree(useDashboardStore.getState().tree)).toHaveLength(0);

    await notifyGeometry();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    scrollerRef.current = scroller;
    await notifyGeometry();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(flattenTree(useDashboardStore.getState().tree)).toHaveLength(1);
    expect(latest?.reachedTop).toBe(true);
  });

  it("scrollHeight가 clientHeight + margin을 넘으면 추가 요청을 멈춘다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([2], "cursor-1"));
    vi.stubGlobal("fetch", fetchMock);
    setGeometry(scroller, { clientHeight: 600, scrollHeight: 801 });

    await renderSession("sess-filled");
    await notifyGeometry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(latest?.blockedReason).toBeNull();
  });

  it("viewport 확대나 tool group 재접힘으로 다시 underfill되면 같은 geometry 경로가 새 run을 시작한다", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page([2], "cursor-1"))
      .mockResolvedValueOnce(page([1], "cursor-2"));
    vi.stubGlobal("fetch", fetchMock);
    setGeometry(scroller, { clientHeight: 600, scrollHeight: 801 });

    await renderSession("sess-resized");
    await notifyGeometry();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setGeometry(scroller, { clientHeight: 800, scrollHeight: 900 });
    await notifyGeometry();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("한 run의 5 page cap에서 멈추고 수동 성공은 새 budget으로 latch를 해제한다", async () => {
    const fetchMock = vi.fn();
    for (let pageIndex = 0; pageIndex <= MAX_VIEWPORT_FILL_PAGES; pageIndex += 1) {
      fetchMock.mockResolvedValueOnce(page(
        [100 - pageIndex],
        `cursor-${pageIndex + 1}`,
      ));
    }
    vi.stubGlobal("fetch", fetchMock);

    await renderSession("sess-cap");
    for (let pageIndex = 1; pageIndex < MAX_VIEWPORT_FILL_PAGES; pageIndex += 1) {
      await notifyGeometry();
    }
    await notifyGeometry();

    expect(fetchMock).toHaveBeenCalledTimes(MAX_VIEWPORT_FILL_PAGES);
    expect(latest?.blockedReason).toBe("cap");

    await requestOlder("manual");

    expect(fetchMock).toHaveBeenCalledTimes(MAX_VIEWPORT_FILL_PAGES + 1);
    expect(latest?.blockedReason).toBeNull();
  });

  it.each([
    ["non-2xx", () => Promise.resolve(new Response("no", { status: 503 }))],
    ["throw", () => Promise.reject(new Error("network"))],
  ])("%s 실패는 자동 재시도 없이 error latch로 수렴하고 수동 성공만 해제한다", async (_name, fail) => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(fail)
      .mockResolvedValueOnce(page([1], "cursor-1"));
    vi.stubGlobal("fetch", fetchMock);

    await renderSession("sess-error");
    expect(latest?.blockedReason).toBe("error");

    await notifyGeometry();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await requestOlder("manual");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest?.blockedReason).toBeNull();
  });

  it("빈 page + non-null cursor는 진행 불능 error로 격리하고 budget을 더 쓰지 않는다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([], "cursor-never-advances"));
    vi.stubGlobal("fetch", fetchMock);

    await renderSession("sess-empty-page");
    await notifyGeometry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(latest?.blockedReason).toBe("error");
  });

  it("반복 cursor는 다음 page 반영 전에 error로 격리한다", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page([3], "cursor-repeat"))
      .mockResolvedValueOnce(page([2], "cursor-repeat"));
    vi.stubGlobal("fetch", fetchMock);

    await renderSession("sess-repeat");
    await notifyGeometry();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest?.blockedReason).toBe("error");
    expect(flattenTree(useDashboardStore.getState().tree)).toHaveLength(1);
  });

  it("loadingRef busy 중 자동·수동·geometry 진입은 중복 fetch를 만들지 않는다", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetchMock);

    await renderSession("sess-busy");
    expect(latest?.loading).toBe(true);

    await act(async () => {
      latest?.requestOlder("automatic");
      latest?.requestOlder("manual");
      latest?.notifyViewportGeometry();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(page([1], "cursor-1"));
      await pending.promise;
    });
    await flush();
  });

  it("clientHeight 0에서는 기다리고 같은 geometry 경로가 준비되면 자동 채움을 재개한다", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page([2], "cursor-1"))
      .mockResolvedValueOnce(page([1], "cursor-2"));
    vi.stubGlobal("fetch", fetchMock);
    setGeometry(scroller, { clientHeight: 0, scrollHeight: 0 });

    await renderSession("sess-not-ready");
    await notifyGeometry();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setGeometry(scroller, { clientHeight: 600, scrollHeight: 100 });
    await notifyGeometry();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("세션 전환 뒤 늦게 끝난 old promise는 store·cursor·latch와 자동 루프를 건드리지 않는다", async () => {
    const oldPage = deferred<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce(page([20], null));
    vi.stubGlobal("fetch", fetchMock);

    await renderSession("sess-old");
    await renderSession("sess-new");
    expect(latest?.reachedTop).toBe(true);

    await act(async () => {
      oldPage.resolve(page([10], "old-cursor"));
      await oldPage.promise;
    });
    await flush();

    expect(flattenTree(useDashboardStore.getState().tree).map((message) => message.eventId)).toEqual([20]);
    expect(latest?.reachedTop).toBe(true);
    expect(latest?.blockedReason).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("unmount cleanup 뒤 늦게 끝난 promise는 store를 변경하지 않는다", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetchMock);

    await renderSession("sess-unmount");
    await act(async () => root.unmount());

    await act(async () => {
      pending.resolve(page([1], "cursor-old"));
      await pending.promise;
    });
    await flush();

    expect(flattenTree(useDashboardStore.getState().tree)).toHaveLength(0);
    root = createRoot(container);
  });
});

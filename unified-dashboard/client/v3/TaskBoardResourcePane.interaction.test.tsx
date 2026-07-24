/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionSummary } from "@seosoyoung/soul-ui";

import { TaskBoardResourcePane } from "./TaskBoardResourcePane";
import type { RunSessionLoadState } from "./task-workspace-model";

describe("TaskBoardResourcePane 세션 탭 우클릭 (🔴30)", () => {
  let container: HTMLDivElement;
  let root: Root;

  const session: SessionSummary = {
    agentSessionId: "s1",
    status: "completed",
    eventCount: 3,
    displayName: "보드 세션",
    agentId: "roselin_codex",
    agentName: "로젤린",
    nodeId: "eiaserinnys",
    createdAt: "2026-07-24T00:00:00Z",
  } as SessionSummary;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    document.body.replaceChildren();
  });

  function render(onSessionContextMenu: (session: SessionSummary, event: unknown) => void) {
    flushSync(() => root.render(
      <TaskBoardResourcePane
        taskId="rb-1"
        taskTitle="보드뷰 개선"
        sessionIds={["s1"]}
        sessions={[session]}
        runSessionLoadStates={new Map<string, RunSessionLoadState>([["s1", "ready"]])}
        activeSessionId={null}
        boardItems={[]}
        openedResources={[]}
        activeTabId="sessions"
        onOpenSession={vi.fn()}
        onOpenDocument={vi.fn()}
        onActiveTabChange={vi.fn()}
        onSessionContextMenu={onSessionContextMenu}
      />,
    ));
  }

  it("세션 행에서 contextmenu 이벤트가 나면 공통 메뉴 콜백을 세션·좌표와 함께 호출한다", () => {
    let capturedSessionId: string | null = null;
    let capturedClientX: number | null = null;
    // 콜백(=TaskBoardWorkspace.openSessionContextMenu)이 preventDefault로 브라우저 기본 메뉴를 막을 수 있도록,
    // 행이 취소 가능한 실제 이벤트를 그대로 전달하는지 확인한다.
    const onSessionContextMenu = vi.fn((session: SessionSummary, event: { preventDefault(): void; clientX: number }) => {
      capturedSessionId = session.agentSessionId;
      capturedClientX = event.clientX;
      event.preventDefault();
    });
    render(onSessionContextMenu as never);

    const row = container.querySelector<HTMLElement>('.v3-run-row[data-session-id="s1"]');
    expect(row).not.toBeNull();

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 48 });
    flushSync(() => { row?.dispatchEvent(event); });

    expect(onSessionContextMenu).toHaveBeenCalledTimes(1);
    expect(capturedSessionId).toBe("s1");
    expect(capturedClientX).toBe(120);
    // 전달된 이벤트로 preventDefault가 실제 DOM 이벤트에 반영된다(취소 가능한 실 이벤트 forwarding).
    expect(event.defaultPrevented).toBe(true);
  });
});

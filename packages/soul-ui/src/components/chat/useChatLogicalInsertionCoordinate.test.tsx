/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ChatMessage } from "../../lib/flatten-tree";
import type { MessageOrGroup } from "../../lib/grouping";
import type { ChatTimelineItem } from "./ChatView.thinking-indicator";
import { useChatLogicalInsertionCoordinate } from "./useChatLogicalInsertionCoordinate";

function row(key: string): MessageOrGroup {
  return {
    type: "single",
    msg: {
      treeNodeId: key,
      eventId: Number(key.replace(/\D/g, "")) || 1,
      role: "assistant",
      content: key,
      treeNodeType: "assistant_message",
    } as ChatMessage,
  };
}

interface HarnessProps {
  grouped: ChatTimelineItem[];
  sessionKey: string;
  prependedCount: number;
}

let latest: ReturnType<typeof useChatLogicalInsertionCoordinate> | null = null;

function Harness(props: HarnessProps) {
  latest = useChatLogicalInsertionCoordinate(
    props.grouped,
    props.sessionKey,
    props.prependedCount,
  );
  return null;
}

describe("useChatLogicalInsertionCoordinate reset boundaries", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root !== null) flushSync(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    latest = null;
  });

  function render(props: HarnessProps) {
    if (root === null) {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    flushSync(() => root?.render(<Harness {...props} />));
    if (latest === null) throw new Error("hook 결과가 없습니다.");
    return latest;
  }

  it("같은 세션의 logical insert는 유지하고 non-empty count 감소와 session switch는 초기화한다", () => {
    const original = [row("row-100"), row("row-200")];
    const inserted = [row("row-50"), ...original];
    const initial = render({ grouped: original, sessionKey: "s1", prependedCount: 3 });
    initial.recordFirstVisibleKey("row-200");

    expect(render({
      grouped: inserted,
      sessionKey: "s1",
      prependedCount: 3,
    }).firstItemIndex).toBe(9_996);

    // clearTree가 빈 렌더를 거치지 않아도 store count 감소 자체가 stale basis를 폐기한다.
    expect(render({
      grouped: inserted,
      sessionKey: "s1",
      prependedCount: 2,
    }).firstItemIndex).toBe(9_998);

    // 이후의 정상 history prepend는 실제 prependedCount 의미만 반영한다.
    expect(render({
      grouped: inserted,
      sessionKey: "s1",
      prependedCount: 4,
    }).firstItemIndex).toBe(9_996);

    expect(render({
      grouped: [row("row-900")],
      sessionKey: "s2",
      prependedCount: 1,
    }).firstItemIndex).toBe(9_999);
  });

  it("마지막 생각 중 행의 표시 전환은 prepend 좌표를 움직이지 않는다", () => {
    const original = [row("row-100")];
    const initial = render({ grouped: original, sessionKey: "s1", prependedCount: 0 });
    initial.recordFirstVisibleKey("row-100");

    expect(render({
      grouped: [...original, { type: "thinking-indicator" }],
      sessionKey: "s1",
      prependedCount: 0,
    }).firstItemIndex).toBe(10_000);
  });
});

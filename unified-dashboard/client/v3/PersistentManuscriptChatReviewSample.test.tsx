/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useDashboardStore } from "@seosoyoung/soul-ui/stores/dashboard-store";
import { PersistentManuscriptChatReviewSample } from "./PersistentManuscriptChatReviewSample";

vi.mock("@seosoyoung/soul-ui", async () => {
  const { createElement } = await import("react");
  const { useDashboardStore } = await import("@seosoyoung/soul-ui/stores/dashboard-store");
  return { useDashboardStore, ChatView: (props: { presentation: string }) => createElement("div", { "data-presentation": props.presentation }) };
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("manuscript review isolation", () => {
  it("mounts ChatView and restores the previous session without reverting preference changes", () => {
    const original = useDashboardStore.getState();
    original.setActiveSession("previous");
    original.processEvents([{ eventId: 1, event: { type: "assistant_message", content: "previous transcript" } }]);
    const previous = useDashboardStore.getState();
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      act(() => root.render(<PersistentManuscriptChatReviewSample />));
      expect(host.querySelector('[data-presentation="manuscript"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="default-review-column"][data-chat-presentation="default"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="manuscript-review-column"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="default-review-column"]')?.textContent).toContain("턴 완료");
      expect(useDashboardStore.getState().activeSessionKey).toBe("components-review-manuscript");
      act(() => {
        useDashboardStore.getState().setChatFontSize(18);
        useDashboardStore.getState().setDraft("components-review-manuscript", "sample draft");
        useDashboardStore.getState().setDraft("unrelated", "keep this");
        (Array.from(host.querySelectorAll("button")).find(button => button.textContent === "전송 실패")!).click();
      });
      expect(useDashboardStore.getState().pendingChatSends["components-review-manuscript"]?.status).toBe("failed");
      act(() => (Array.from(host.querySelectorAll("button")).find(button => button.textContent === "사용량 줄 끄기")!).click());
      expect(useDashboardStore.getState().persistentSessionDisplaySettings?.showTurnUsage).toBe(false);
      expect(useDashboardStore.getState().persistentSessionDisplaySettings?.showJevCandidates).toBe(true);
      act(() => (Array.from(host.querySelectorAll("button")).find(button => button.textContent === "사용량 줄 켜기")!).click());
      expect(useDashboardStore.getState().persistentSessionDisplaySettings?.showTurnUsage).toBe(true);
      act(() => root.unmount());
      const restored = useDashboardStore.getState();
      expect(restored.activeSessionKey).toBe("previous");
      expect(restored.tree).toBe(previous.tree);
      expect(restored.processingCtx).toBe(previous.processingCtx);
      expect(restored.chatFontSize).toBe(18);
      expect(restored.drafts.unrelated).toBe("keep this");
      expect(restored.drafts["components-review-manuscript"]).toBeUndefined();
      expect(restored.pendingChatSends["components-review-manuscript"]).toBeUndefined();
    } finally {
      useDashboardStore.setState(original);
    }
  });
});

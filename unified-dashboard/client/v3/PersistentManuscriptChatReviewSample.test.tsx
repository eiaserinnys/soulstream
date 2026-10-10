/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useDashboardStore } from "@seosoyoung/soul-ui/stores/dashboard-store";
import { flattenTree } from "@seosoyoung/soul-ui/lib/flatten-tree";
import { projectManuscriptMessages } from "@seosoyoung/soul-ui/lib/manuscript-agent-message-projection";
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
      act(() => (Array.from(host.querySelectorAll("button")).find(button => button.textContent === "숨김")!).click());
      expect(useDashboardStore.getState().persistentSessionDisplaySettings?.turnUsageMode).toBe("hidden");
      expect(useDashboardStore.getState().persistentSessionDisplaySettings?.showJevCandidates).toBe(true);
      act(() => (Array.from(host.querySelectorAll("button")).find(button => button.textContent === "펼쳐서")!).click());
      expect(useDashboardStore.getState().persistentSessionDisplaySettings?.turnUsageMode).toBe("expanded");
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

  it("classifies the shared raw PAS fixture while keeping its default rows visible", () => {
    const original = useDashboardStore.getState();
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      act(() => root.render(<PersistentManuscriptChatReviewSample />));
      const flattened = flattenTree(useDashboardStore.getState().tree);
      const sampleMessages = flattened.filter(message =>
        message.deliveryId === "00000000-0000-4000-8000-000000002251"
        || message.deliveryId === "00000000-0000-4000-8000-000000002252"
        || message.inputId === "pas251-projection-agent-report"
        || message.inputId === "pas251-projection-human-image"
        || message.content === "PAS 응답: 첨부 이미지를 확인했습니다.");
      const defaultColumn = host.querySelector('[data-testid="default-review-column"]');
      const manuscriptMessages = projectManuscriptMessages(sampleMessages);
      const humanMessage = sampleMessages.find(message => message.inputId === "pas251-projection-human-image");
      const assistantMessage = sampleMessages.find(message => message.content === "PAS 응답: 첨부 이미지를 확인했습니다.");

      expect(sampleMessages.map(message => message.role)).toEqual([
        "notification", "notification", "user", "user", "assistant",
      ]);
      expect(sampleMessages.map(message => message.deliveryIntent).filter(Boolean)).toEqual([
        "completion_notification", "runtime_followup",
      ]);
      expect(sampleMessages.find(message => message.inputId === "pas251-projection-agent-report")?.callerInfo)
        .toMatchObject({ source: "agent" });
      expect(humanMessage).toMatchObject({
        role: "user",
        callerInfo: { source: "browser" },
        attachmentPaths: [expect.any(String)],
        attachmentNodeId: "eiaserinnys",
      });
      expect(defaultColumn?.textContent).toContain("PAS 완료 알림입니다.");
      expect(defaultColumn?.textContent).toContain("PAS 런타임 후속 알림입니다.");
      expect(defaultColumn?.textContent).toContain("위임 에이전트 검수 보고입니다.");
      expect(defaultColumn?.textContent).toContain("첨부 이미지를 확인해주세요.");
      expect(defaultColumn?.textContent).toContain("PAS 응답: 첨부 이미지를 확인했습니다.");
      expect(manuscriptMessages).toEqual([humanMessage, assistantMessage]);
    } finally {
      act(() => root.unmount());
      useDashboardStore.setState(original);
    }
  });
});

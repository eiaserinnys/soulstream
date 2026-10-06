import { useLayoutEffect, useState } from "react";
import { ChatView, useDashboardStore } from "@seosoyoung/soul-ui";
import { ChatMessageItem } from "@seosoyoung/soul-ui/components/chat/ChatMessageItem";
import { useChatTypography } from "@seosoyoung/soul-ui/components/chat/useChatTypography";
import { getSessionResetState } from "@seosoyoung/soul-ui/stores/slices/_session-reset";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";
import type { SoulSSEEvent } from "@seosoyoung/soul-ui/shared/types";

const REVIEW_SESSION = "components-review-manuscript";

function makeMessage(role: ChatMessage["role"], id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role,
    content: "",
    treeNodeId: `review-${id}`,
    treeNodeType: role,
    ...extra,
  } as ChatMessage;
}

const messages: ChatMessage[] = [
  makeMessage("assistant", "long-answer", {
    content: "이 결과는 입력과 첨부를 같은 전송 경로로 처리합니다.\n\n한글 문장이 긴 경우에도 낱말 중간을 먼저 나누지 않고, 열 폭을 넘어가는 긴 문자열은 화면 안에서 접습니다. 다음 문단도 기존 Markdown 렌더러가 같은 글자 설정으로 보여 줍니다.",
  }),
  makeMessage("assistant", "streaming", {
    content: "지금은 응답을 이어 쓰고 있습니다.",
    isStreaming: true,
  }),
  makeMessage("user", "user-message", {
    content: "내 입력은 오른쪽에 놓입니다.\n줄바꿈과 긴 한글 단어도 보존합니다.",
  }),
  makeMessage("intervention", "intervention", {
    content: "실행 중인 작업에 보낸 개입 메시지입니다.",
  }),
  makeMessage("user", "attachments", {
    content: "첨부 이미지와 파일 링크입니다.\n\n![샘플 이미지](/icon-192.png)\n\n[검수 메모.pdf 열기](https://example.com/review-note.pdf)",
  }),
  makeMessage("tool_approval", "approval", {
    content: "파일을 수정하기 전에 승인이 필요합니다.",
    approvalId: "components-review-approval",
    approvalResolved: false,
  }),
  makeMessage("tool", "tool", {
    content: "Read · packages/soul-ui/src/components/chat/ChatView.tsx",
    toolName: "Read",
  }),
  makeMessage("system", "error", {
    content: "응답 연결이 끊겼습니다. 다시 시도할 수 있습니다.",
    treeNodeType: "error",
    isError: true,
  }),
  makeMessage("system", "jev", {
    content: "",
    treeNodeType: "persistent_jev_candidates",
    jevCandidates: [{
      label: "#412",
      line: "입력과 같은 대화 아래에 표시되는 Jev 후보",
      score: 2,
    }],
  }),
  makeMessage("system", "generation", {
    content: "",
    treeNodeType: "generation_started",
  }),
];

/** The review route borrows only session state, then restores it on departure.
 * Maps keep other sessions' changes; preferences are never snapshotted. */
function ManuscriptColumn() {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const store = useDashboardStore.getState();
    const saved = Object.fromEntries(
      [...Object.keys(getSessionResetState()), "activeSessionSummary"].map(key => [key, store[key as keyof typeof store]]),
    );
    const savedDraft = store.drafts[REVIEW_SESSION];
    const savedPending = store.pendingChatSends[REVIEW_SESSION];
    const savedSuggestion = store.lastPromptSuggestions[REVIEW_SESSION];
    store.setActiveSession(REVIEW_SESSION);
    store.setActiveSessionSummary({
      agentSessionId: REVIEW_SESSION, status: "completed", sessionType: "claude", eventCount: 10,
      createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z",
    });
    store.setPersistentSessionDisplaySettings(REVIEW_SESSION, { show_generation_separator: true, show_jev_candidates: true });
    const events = [
      { type: "assistant_message", content: "첫 줄부터 흐리지 않고 읽을 수 있습니다.\n\n대화 글자는 운영의 설정을 따릅니다." },
      { type: "user_message", user: "User", text: "긴 내 발언은 왼쪽에 여백을 남깁니다. 여러 줄로 이어지는 글도 오른쪽 끝을 유지하고, 목록과 코드와 첨부는 내용 폭으로 정렬합니다.\n첫째 줄\n둘째 줄\n\n첫 문단입니다.\n\n둘째 문단입니다." },
      { type: "assistant_message", content: "- 문단과 목록의 행간은 같습니다\n- 본문은 1.6배입니다\n\n| 항목 | 값 |\n| --- | --- |\n| 행간 | 1.6 |" },
      { type: "tool_approval_requested", approval_id: "review-approval", tool_use_id: "review-tool", tool_name: "Edit", tool_input: { file_path: "review.txt" }, timestamp: 0 },
      { type: "complete", result: "응답 완료", usage: { input_tokens: 1200, output_tokens: 340 }, total_cost_usd: 0.07 },
      { type: "generation_started", timestamp: 0 },
      { type: "error", message: "응답 연결이 끊겼습니다." },
      { type: "intervention_sent", user: "User", text: "실행 중 보낸 발언도 같은 여백을 유지합니다." },
      { type: "user_message", user: "User", text: "첨부 이미지와 파일 링크입니다.\n\n- 첫째 메모\n- 둘째 메모\n\n```ts\nconst manuscript = true;\n```\n\n| 항목 | 값 |\n| --- | --- |\n| 모양 | 원고형 |\n\n![샘플 이미지](/icon-192.png)\n\n[검수 메모.pdf](https://example.com/review-note.pdf)" },
      { type: "assistant_message", content: "마지막 문장 아래에도 여유가 있습니다." },
    ] as SoulSSEEvent[];
    store.processEvents(events.map((event, index) => ({ event, eventId: index + 1 })));
    setReady(true);
    return () => {
      useDashboardStore.setState(state => {
        const drafts = { ...state.drafts };
        const pendingChatSends = { ...state.pendingChatSends };
        const lastPromptSuggestions = { ...state.lastPromptSuggestions };
        delete drafts[REVIEW_SESSION];
        delete pendingChatSends[REVIEW_SESSION];
        delete lastPromptSuggestions[REVIEW_SESSION];
        if (savedDraft !== undefined) drafts[REVIEW_SESSION] = savedDraft;
        if (savedPending !== undefined) pendingChatSends[REVIEW_SESSION] = savedPending;
        if (savedSuggestion !== undefined) lastPromptSuggestions[REVIEW_SESSION] = savedSuggestion;
        return { ...saved, drafts, pendingChatSends, lastPromptSuggestions };
      });
    };
  }, []);

  const showPending = (status: "sending" | "failed" | null) => {
    useDashboardStore.getState().setPendingChatSend(REVIEW_SESSION, status ? {
      id: "review-pending", status, text: "대기 발언 첫째 줄\n둘째 줄",
      messageText: "대기 발언 첫째 줄\n둘째 줄", attachmentPaths: [], attachments: [],
      mode: "resume", reason: "전달을 확인하지 못했습니다",
    } : null);
  };
  return <div className="w-full lg:w-[568px] shrink-0 bg-[var(--persistent-session-paper)] p-6 overflow-hidden">
    <div className="flex gap-2 pb-3 text-xs text-muted-foreground">
      <button onClick={() => showPending(null)}>원고형</button>
      <button onClick={() => showPending("sending")}>전송 중</button>
      <button onClick={() => showPending("failed")}>전송 실패</button>
    </div>
    <div className="h-screen min-h-0" data-testid="manuscript-review-column">
      {ready && <ChatView presentation="manuscript" historyEnabled={false} fileUploadUrl="/api/attachments/sessions" />}
    </div>
  </div>;
}

export function PersistentManuscriptChatReviewSample() {
  const { chatTypographyStyle } = useChatTypography();
  return <div className="flex w-full flex-col items-center gap-4 overflow-x-hidden lg:flex-row lg:items-start lg:justify-center" data-testid="persistent-manuscript-chat-review">
    <div className="w-full max-w-[520px] bg-background" style={chatTypographyStyle}>
      <p className="px-3 py-2 text-sm font-medium text-muted-foreground">기본 모양</p>
      {messages.map(msg => <ChatMessageItem key={msg.id} msg={msg} sessionId="components-review-pas" />)}
    </div>
    <ManuscriptColumn />
  </div>;
}

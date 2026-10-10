import { useLayoutEffect, useState } from "react";
import { ChatView, useDashboardStore } from "@seosoyoung/soul-ui";
import { ChatMessageItem } from "@seosoyoung/soul-ui/components/chat/ChatMessageItem";
import { useChatTypography } from "@seosoyoung/soul-ui/components/chat/useChatTypography";
import { getSessionResetState } from "@seosoyoung/soul-ui/stores/slices/_session-reset";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";
import type { SoulSSEEvent } from "@seosoyoung/soul-ui/shared/types";
import type { PersistentTurnUsageMode } from "@seosoyoung/soul-ui";

const REVIEW_SESSION = "components-review-manuscript";
const PAS_8309_IMAGE_URLS = [
  "https://soulstream.eiaserinnys.me/api/attachments/files?nodeId=eiaserinnys&path=%2Fhome%2Feias%2Fmigration%2Fnetcup-core-bootstrap%2Fprod-state%2Fincoming%2F60668e34-f8b1-4e53-9a8e-c5ff304337e1%2F2026-10-08T15-42-19.069Z-pas247-preview-iphone-light-story-settings-0d5b93a9cf014a8d9a9c76a4d203d60e.png",
  "https://soulstream.eiaserinnys.me/api/attachments/files?nodeId=eiaserinnys&path=%2Fhome%2Feias%2Fmigration%2Fnetcup-core-bootstrap%2Fprod-state%2Fincoming%2F60668e34-f8b1-4e53-9a8e-c5ff304337e1%2F2026-10-08T15-42-19.585Z-pas247-preview-iphone-light-story-settings-fe37869a1a9841dc92f8db2ff4186d61.png",
];
const PAS_8309_ATTACHMENT_PATHS = PAS_8309_IMAGE_URLS.map(url => decodeURIComponent(new URL(url).searchParams.get("path")!));
const PAS_251_LANDSCAPE_ATTACHMENT_PATHS = [
  "/home/eias/migration/netcup-core-bootstrap/prod-state/incoming/8617c9ee-401d-4916-a781-3a5bdc89c20a/2026-10-10T08-09-12.820Z-IMG_0168-f8f7698dacb14f55a405e3fcb0a5e4ae.jpg",
  "/home/eias/migration/netcup-core-bootstrap/prod-state/incoming/8617c9ee-401d-4916-a781-3a5bdc89c20a/2026-10-10T08-09-16.935Z-IMG_0169-7b8810c416494cfbba4f1b62c8a5520f.jpg",
];

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
  makeMessage("system", "default-complete", {
    content: "턴 완료",
    treeNodeType: "complete",
    usage: { input_tokens: 6, cache_read_input_tokens: 645_361, output_tokens: 6_139 },
    totalCostUsd: 0.62,
    captionStats: "입력 645,367 (캐시 645,361) · 출력 6,139 · 정가 $0.62 (세션 $17.91)",
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
  const [turnUsageMode, setTurnUsageMode] = useState<PersistentTurnUsageMode>("collapsed");
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
      nodeId: "eiaserinnys",
      createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z",
    });
    store.setPersistentSessionDisplaySettings(REVIEW_SESSION, {
      show_generation_separator: true,
      show_jev_candidates: true,
      show_character: true,
      animate_character: true,
      turn_usage_mode: "collapsed",
    });
    const events = [
      { type: "assistant_message", content: "첫 줄부터 흐리지 않고 읽을 수 있습니다.\n\n대화 글자는 운영의 설정을 따릅니다." },
      { type: "user_message", user: "User", text: "긴 내 발언은 왼쪽에 여백을 남깁니다. 여러 줄로 이어지는 글도 오른쪽 끝을 유지하고, 목록과 코드와 첨부는 내용 폭으로 정렬합니다.\n첫째 줄\n둘째 줄\n\n첫 문단입니다.\n\n둘째 문단입니다." },
      { type: "assistant_message", content: "- 문단과 목록의 행간은 같습니다\n- 본문은 1.6배입니다\n\n| 항목 | 값 |\n| --- | --- |\n| 행간 | 1.6 |" },
      { type: "tool_approval_requested", approval_id: "review-approval", tool_use_id: "review-tool", tool_name: "Edit", tool_input: { file_path: "review.txt" }, timestamp: 0 },
      { type: "complete", result: "가격만 있는 응답", turn_cost_usd: 2.4 },
      { type: "complete", result: "토큰만 있는 응답", usage: { input_tokens: 8, output_tokens: 2 } },
      { type: "complete", result: "표시할 사용량이 없는 응답" },
      { type: "generation_started", timestamp: 0 },
      { type: "context_usage", used_tokens: 500, max_tokens: 1_000, percent: 50 },
      { type: "error", message: "응답 연결이 끊겼습니다." },
      { type: "context_usage", used_tokens: 900, max_tokens: 1_000, percent: 90 },
      { type: "complete", result: "연속 첫 번째 턴", usage: { input_tokens: 900, output_tokens: 30 }, turn_cost_usd: 1.1 },
      { type: "complete", result: "연속 두 번째 턴", usage: { input_tokens: 40, output_tokens: 20 }, turn_cost_usd: 0.2 },
      { type: "intervention_sent", user: "User", text: "실행 중 보낸 발언도 같은 여백을 유지합니다." },
      {
        type: "assistant_message",
        content: `첫 번째 iPhone PAS 시안입니다.\n\n![PAS 설정 시안 1](${PAS_8309_IMAGE_URLS[0]})\n\n설정 화면에서 항목을 선택한 뒤의 시안입니다.\n\n![PAS 설정 시안 2](${PAS_8309_IMAGE_URLS[1]})`,
      },
      {
        type: "user_message",
        user: "User",
        text: "구조화 이미지 첨부입니다.\n\n${PAS_8309_ATTACHMENT_PATHS[0]}\n${PAS_251_LANDSCAPE_ATTACHMENT_PATHS[0]}\n${PAS_251_LANDSCAPE_ATTACHMENT_PATHS[1]}\n/notes/review.txt",
        attachments: [PAS_8309_ATTACHMENT_PATHS[0], ...PAS_251_LANDSCAPE_ATTACHMENT_PATHS, "/notes/review.txt"],
        node_id: "eiaserinnys",
      },
      { type: "user_message", user: "User", text: "첨부 이미지와 파일 링크입니다.\n\n- 첫째 메모\n- 둘째 메모\n\n```ts\nconst manuscript = true;\n```\n\n| 항목 | 값 |\n| --- | --- |\n| 모양 | 원고형 |\n\n![샘플 이미지](/icon-192.png)\n\n[검수 메모.pdf](https://example.com/review-note.pdf)" },
      { type: "assistant_message", content: "마지막 문장 아래에도 여유가 있습니다." },
      { type: "context_usage", used_tokens: 645_367, max_tokens: 1_024_000, percent: 63, estimated: true },
      { type: "complete", result: "응답 완료", usage: { input_tokens: 6, cache_read_input_tokens: 645_361, output_tokens: 6_139 }, total_cost_usd: 0.62, turn_cost_usd: 0.62, session_cost_usd: 17.91 },
      { type: "context_usage", used_tokens: 750, max_tokens: 1_000, percent: 75 },
      {
        type: "turn_summary",
        content: "마지막 응답의 요약입니다.",
        turn_start_event_id: 15,
        final_response_event_id: 16,
        parent_event_id: 16,
        model: "claude",
        latency_ms: 50,
        attempts: 1,
        timestamp: 1,
      },
      { type: "user_message", user: "User", text: "새 요청 원문입니다.", input_id: "empty-assigned-cards" },
      {
        type: "debug",
        kind: "assigned_card_context_snapshot",
        content: "담당 카드 없음",
        timestamp: 1,
        capture: {
          source: "prepared_model_input",
          sessionId: REVIEW_SESSION,
          registrationId: "review-registration",
          executionCommandId: "review-command",
          inputId: "empty-assigned-cards",
          identityMissing: false,
          snapshot: {
            total: 0,
            omitted: 0,
            capturedAt: "2026-10-06T00:00:00Z",
            cards: [],
          },
        },
      },
      { type: "user_message", text: "다른 세션의 첫 위임 보고입니다.", caller_info: { source: "agent", agent_node: "eiaserinnys", agent_id: "roselin", agent_name: "로젤린" } },
      { type: "intervention_sent", user: "roselin", text: "다른 세션이 보낸 개입입니다.", caller_info: { source: "agent", agent_node: "eiaserinnys", agent_id: "roselin", agent_name: "로젤린" } },
      { type: "user_message", text: "다른 세션의 세 번째 메시지입니다.", caller_info: { source: "agent", agent_node: "eiaserinnys", agent_id: "roselin", agent_name: "로젤린" } },
      { type: "user_message", text: "사람이 보낸 발언은 그대로 보입니다.", caller_info: { source: "browser", display_name: "디렉터님" } },
      { type: "assistant_message", content: "서소영 응답도 지금처럼 보입니다." },
      { type: "intervention_sent", user: "Soulstream", text: "시스템 개입은 지금처럼 보입니다.", caller_info: { source: "system", display_name: "Soulstream" } },
      { type: "intervention_sent", user: "roselin", text: "마지막 agent 묶음의 첫 메시지입니다.", caller_info: { source: "agent", agent_node: "eiaserinnys", agent_id: "roselin", agent_name: "로젤린" } },
      { type: "user_message", text: "마지막 agent 묶음의 두 번째 메시지입니다.", caller_info: { source: "agent", agent_node: "eiaserinnys", agent_id: "roselin", agent_name: "로젤린" } },
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
    <div className="flex flex-wrap gap-2 pb-3 text-xs text-muted-foreground">
      <button onClick={() => showPending(null)}>원고형</button>
      <button onClick={() => showPending("sending")}>전송 중</button>
      <button onClick={() => showPending("failed")}>전송 실패</button>
      {(["collapsed", "expanded", "hidden"] as const).map((mode) => <button key={mode} aria-pressed={turnUsageMode === mode} onClick={() => {
        setTurnUsageMode(mode);
        useDashboardStore.getState().setPersistentSessionDisplaySettings(REVIEW_SESSION, {
          show_generation_separator: true,
          show_jev_candidates: true,
          show_character: true,
          animate_character: true,
          turn_usage_mode: mode,
        });
      }}>
        {mode === "collapsed" ? "접어서" : mode === "expanded" ? "펼쳐서" : "숨김"}
      </button>)}
    </div>
    <div className="h-screen min-h-0" data-testid="manuscript-review-column">
      {ready && <ChatView presentation="manuscript" historyEnabled={false} fileUploadUrl="/api/attachments/sessions" />}
    </div>
  </div>;
}

export function PersistentManuscriptChatReviewSample() {
  const { chatTypographyStyle } = useChatTypography();
  return <div className="flex w-full flex-col items-center gap-4 overflow-x-hidden lg:flex-row lg:items-start lg:justify-center" data-testid="persistent-manuscript-chat-review">
    <div className="w-full max-w-[520px] bg-background" style={chatTypographyStyle} data-testid="default-review-column" data-chat-presentation="default">
      <p className="px-3 py-2 text-sm font-medium text-muted-foreground">기본 모양</p>
      {messages.map(msg => <ChatMessageItem key={msg.id} msg={msg} sessionId="components-review-pas" />)}
    </div>
    <ManuscriptColumn />
  </div>;
}

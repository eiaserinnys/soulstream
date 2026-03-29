/**
 * ChatView - SSE 이벤트를 시간순 채팅 로그로 표시
 *
 * 트리를 flat 메시지 리스트로 변환하여 DM 스타일 채팅 UI로 렌더링합니다.
 * 하단에 ChatInput을 배치하여 인터벤션/리줌 메시지를 전송합니다.
 *
 * Follow mode: NodeGraph 패턴과 동일한 follow/unfollow 토글.
 * Tool grouping: 연속된 tool 메시지를 접기/펼치기 그룹으로 묶어 표시.
 */

import { memo, useMemo, useRef, useEffect, useState, useCallback } from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import type { SessionSummary, InputRequestQuestion, ContextItem } from "@shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import { flattenTree, type ChatMessage } from "../lib/flatten-tree";
import { submitInputResponse } from "../lib/input-request-actions";
import { useInputRequestTimer } from "../hooks/useInputRequestTimer";
import { formatTime } from "../lib/input-request-utils";
import { ChatInput } from "./ChatInput";
import { ProfileAvatar } from "./ProfileAvatar";
import { ContextContentRenderer } from "./ContextContentRenderer";
import { MarkdownContent } from "./MarkdownContent";
import { cn } from "../lib/cn";

/** 스크롤 하단 판정 threshold (px) */
const SCROLL_THRESHOLD = 50;

// === LLM Context ===

interface LlmContext {
  isLlm: boolean;
  llmModel?: string;
  llmProvider?: string;
}

function useLlmContext(): LlmContext {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const sessions = useDashboardStore((s) => s.sessions);
  return useMemo(() => {
    if (!activeSessionKey) return { isLlm: false };
    const session = sessions.find(
      (s: SessionSummary) => s.agentSessionId === activeSessionKey,
    );
    if (!session || session.sessionType !== "llm") return { isLlm: false };
    return {
      isLlm: true,
      llmModel: session.llmModel,
      llmProvider: session.llmProvider,
    };
  }, [activeSessionKey, sessions]);
}

// === Truncation Lazy Load ===

/**
 * truncate된 콘텐츠의 "전체 내용 보기" 버튼 + 로딩 상태 관리.
 * 클릭 시 서버에서 전체 이벤트를 가져와 콘텐츠를 반환한다.
 */
function useLazyLoadContent(
  msg: ChatMessage,
): {
  displayContent: string | undefined;
  isTruncated: boolean;
  loading: boolean;
  error: string | null;
  loadFullContent: () => void;
} {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const isTruncated = !!msg.isTruncated && fullContent === null;

  const loadFullContent = useCallback(async () => {
    if (!activeSessionKey || !msg.fullContentEventId || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(activeSessionKey)}/events/${msg.fullContentEventId}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const record = await res.json();
      const event = record.event;
      // tool_result 이벤트: result 필드, thinking 이벤트: thinking 필드
      const content = event.result ?? event.thinking ?? event.text ?? "";
      setFullContent(content);
    } catch {
      setError("로드 실패. 다시 시도해주세요.");
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [activeSessionKey, msg.fullContentEventId]);

  // tool 메시지의 경우 toolResult, thinking의 경우 content
  const baseContent =
    msg.treeNodeType === "thinking"
      ? msg.thinkingContent ?? msg.content
      : msg.toolResult;

  return {
    displayContent: fullContent ?? baseContent,
    isTruncated,
    loading,
    error,
    loadFullContent,
  };
}

/** truncate된 콘텐츠 하단에 표시하는 "전체 내용 보기" 버튼 */
const ShowFullContentButton = memo(function ShowFullContentButton({
  loading,
  error,
  onClick,
}: {
  loading: boolean;
  error: string | null;
  onClick: () => void;
}) {
  return (
    <div className="mt-1 flex items-center gap-2">
      <button
        onClick={onClick}
        disabled={loading}
        className="text-[11px] text-accent-blue hover:text-accent-blue/80 flex items-center gap-1 disabled:opacity-50"
      >
        {loading ? (
          <>
            <span className="inline-block w-3 h-3 border border-accent-blue/40 border-t-accent-blue rounded-full animate-spin" />
            Loading...
          </>
        ) : (
          "\u2026 전체 내용 보기"
        )}
      </button>
      {error && (
        <span className="text-[11px] text-accent-red">{error}</span>
      )}
    </div>
  );
});

// === Message Grouping Types ===

type MessageOrGroup =
  | { type: "single"; msg: ChatMessage }
  | { type: "tool-group"; messages: ChatMessage[] };

function groupMessages(messages: ChatMessage[]): MessageOrGroup[] {
  const result: MessageOrGroup[] = [];
  let toolBuffer: ChatMessage[] = [];

  const flushTools = () => {
    if (toolBuffer.length === 0) return;
    if (toolBuffer.length === 1) {
      result.push({ type: "single", msg: toolBuffer[0] });
    } else {
      result.push({ type: "tool-group", messages: [...toolBuffer] });
    }
    toolBuffer = [];
  };

  for (const msg of messages) {
    if (msg.role === "tool") {
      toolBuffer.push(msg);
    } else {
      flushTools();
      result.push({ type: "single", msg });
    }
  }
  flushTools();
  return result;
}

// === Utility Components ===

/** 접기/펼치기 가능한 3줄 미리보기 컴포넌트 (thinking, complete 노드 공용) */
const CollapsibleContent = memo(function CollapsibleContent({
  content,
  label,
}: {
  content: string;
  label: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const needsCollapse = lines.length > 3;
  const preview = needsCollapse ? lines.slice(0, 3).join("\n") + "..." : content;

  return (
    <div>
      {needsCollapse ? (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[13px] text-muted-foreground hover:text-foreground mb-0.5 flex items-center gap-1"
        >
          <span className="text-[11px]">{expanded ? "\u25BC" : "\u25B6"}</span>
          {label}
        </button>
      ) : (
        <span className="text-[13px] text-muted-foreground mb-0.5 flex items-center gap-1">
          {label}
        </span>
      )}
      <pre className="text-[12px] text-muted-foreground bg-input rounded px-2 py-1.5 whitespace-pre-wrap break-words overflow-auto max-h-60 font-mono">
        {expanded || !needsCollapse ? content : preview}
      </pre>
    </div>
  );
});

/** user_message의 구조화된 맥락 표시 (ToolCallGroup과 동일한 접기/펼치기 스타일) */
const ContextBlock = memo(function ContextBlock({ items }: { items: ContextItem[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mt-1.5">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="text-[13px] text-muted-foreground hover:text-foreground flex items-center gap-1.5"
      >
        <span className="text-[11px]">{expanded ? "\u25BC" : "\u25B6"}</span>
        <span>{"\u{1F4CB}"}</span>
        <span className="font-medium">Context ({items.length})</span>
      </button>
      {expanded && (
        <div className="ml-4 mt-1 space-y-1.5">
          {items.map((item: ContextItem) => (
            <div key={item.key}>
              <div className="text-[11px] text-muted-foreground uppercase tracking-wide mb-0.5">
                {item.label}
              </div>
              <ContextContentRenderer content={item.content} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

// === Message Components ===

const UserMessage = memo(function UserMessage({ msg, llmContext }: { msg: ChatMessage; llmContext?: LlmContext }) {
  const config = useDashboardStore((s) => s.dashboardConfig);
  const userConfig = config?.user;

  const isLlm = llmContext?.isLlm ?? false;
  const displayName = isLlm
    ? "USER"
    : userConfig && userConfig.name !== "USER"
      ? `${userConfig.name}`
      : "User";
  const displayId = isLlm ? null : userConfig?.id ? `${userConfig.id}` : null;
  const hasPortrait = isLlm ? false : userConfig?.hasPortrait ?? false;

  return (
    <div className="flex gap-2 px-3 py-1.5" data-tree-node-id={msg.treeNodeId}>
      <ProfileAvatar
        role="user"
        hasPortrait={hasPortrait}
        fallbackEmoji={"\u{1F464}"}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 mb-0.5">
          <span className="text-[15px] font-bold text-accent-blue uppercase tracking-wide">
            {displayName}
          </span>
          {displayId && (
            <span className="text-[11px] text-muted-foreground">
              {displayId}
            </span>
          )}
        </div>
        <div className="text-[15px] text-foreground break-words">
          <MarkdownContent content={msg.content} />
        </div>
        {msg.contextItems && msg.contextItems.length > 0 && (
          <ContextBlock items={msg.contextItems} />
        )}
      </div>
    </div>
  );
});

const InterventionMessage = memo(function InterventionMessage({ msg }: { msg: ChatMessage }) {
  const config = useDashboardStore((s) => s.dashboardConfig);
  const userConfig = config?.user;
  const displayName = userConfig && userConfig.name !== "USER"
    ? `${userConfig.name}`
    : "Intervention";
  const displayId = userConfig?.id ? `${userConfig.id}` : null;

  return (
    <div className="flex gap-2 px-3 py-1.5" data-tree-node-id={msg.treeNodeId}>
      <ProfileAvatar
        role="user"
        hasPortrait={userConfig?.hasPortrait ?? false}
        fallbackEmoji={"\u270B"}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 mb-0.5">
          <span className="text-[15px] font-bold text-accent-orange uppercase tracking-wide">
            {displayName}
          </span>
          {displayId && (
            <span className="text-[11px] text-muted-foreground">
              {displayId}
            </span>
          )}
        </div>
        <div className="text-[15px] text-foreground whitespace-pre-wrap break-words">{msg.content}</div>
      </div>
    </div>
  );
});

/** thinking 노드: 3줄 미리보기 + 접기/펼치기 + truncation lazy load */
const ThinkingMessage = memo(function ThinkingMessage({ msg }: { msg: ChatMessage }) {
  const { displayContent, isTruncated, loading, error, loadFullContent } = useLazyLoadContent(msg);

  return (
    <div className="flex gap-2 px-3 py-1.5" data-tree-node-id={msg.treeNodeId}>
      <span className="w-8 shrink-0" />
      <div className="flex-1 min-w-0">
        <CollapsibleContent content={displayContent ?? msg.content} label={"\u{1F4AD} Thinking"} />
        {isTruncated && (
          <ShowFullContentButton loading={loading} error={error} onClick={loadFullContent} />
        )}
      </div>
    </div>
  );
});

/** text 노드: 일반 텍스트 표시 */
const AssistantMessage = memo(function AssistantMessage({ msg, llmContext }: { msg: ChatMessage; llmContext?: LlmContext }) {
  const config = useDashboardStore((s) => s.dashboardConfig);
  const activeSession = useDashboardStore((s) => {
    const key = s.activeSessionKey;
    return key ? s.sessions.find((ss) => ss.agentSessionId === key) : null;
  });

  // 세션에 바인딩된 에이전트 정보
  const agentName = activeSession?.agentName;
  const agentPortraitUrl = activeSession?.agentPortraitUrl;

  const isLlm = llmContext?.isLlm ?? false;
  // LLM 세션: assistant_message에 model 정보가 있으면 표시, 없으면 llmContext에서 가져옴
  const modelLabel = msg.model ?? llmContext?.llmModel;
  const displayName = isLlm
    ? modelLabel ? `ASSISTANT (${modelLabel})` : "ASSISTANT"
    : agentName ?? "Assistant";
  const displayId = isLlm ? null : activeSession?.agentId ?? null;
  const hasPortrait = isLlm ? false : !!agentPortraitUrl;

  // 토큰 사용량 (assistant_message 노드에 usage가 있을 때 인라인 표시)
  const tokenInfo = msg.usage
    ? `${(msg.usage.input_tokens + msg.usage.output_tokens).toLocaleString()} tokens`
    : null;

  return (
    <div className="flex gap-2 px-3 py-1.5" data-tree-node-id={msg.treeNodeId}>
      <ProfileAvatar
        role="assistant"
        hasPortrait={hasPortrait}
        fallbackEmoji={"\u{1F916}"}
        portraitUrl={agentPortraitUrl}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 mb-0.5">
          <span className="text-[15px] font-bold text-foreground uppercase tracking-wide">
            {displayName}
          </span>
          {displayId && (
            <span className="text-[11px] text-muted-foreground">
              {displayId}
            </span>
          )}
          {isLlm && tokenInfo && (
            <span className="text-[11px] text-muted-foreground/70 font-normal normal-case">
              {tokenInfo}
            </span>
          )}
        </div>
        {msg.isStreaming ? (
          <div className="text-[15px] text-foreground whitespace-pre-wrap break-words">
            {msg.content}
            <span className="inline-block w-1.5 h-3.5 bg-foreground/60 ml-0.5 animate-pulse" />
          </div>
        ) : (
          <div className="text-[15px] text-foreground break-words">
            <MarkdownContent content={msg.content} />
          </div>
        )}
      </div>
    </div>
  );
});

// === Tool Call Components ===

/** 그룹 내 개별 tool call 항목 (truncation lazy load 포함) */
const ToolCallItem = memo(function ToolCallItem({ msg }: { msg: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const { displayContent, isTruncated, loading, error, loadFullContent } = useLazyLoadContent(msg);
  const isDone = msg.toolResult !== undefined || msg.toolDurationMs !== undefined;
  const statusIcon = msg.isError ? "\u274C" : isDone ? "\u2705" : "\u{1F528}";

  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "text-[13px] font-mono flex items-center gap-1",
          msg.isError ? "text-accent-red" : "text-muted-foreground",
          "hover:text-foreground",
        )}
      >
        <span className="text-[11px]">{expanded ? "\u25BC" : "\u25B6"}</span>
        <span>{statusIcon}</span>
        <span className="truncate">{msg.content}</span>
      </button>
      {expanded && msg.toolInput && (
        <pre className="text-[12px] text-muted-foreground bg-input rounded px-2 py-1.5 ml-5 mt-0.5 whitespace-pre-wrap break-words overflow-auto max-h-40 font-mono">
          {typeof msg.toolInput === "string" ? msg.toolInput : JSON.stringify(msg.toolInput, null, 2)}
        </pre>
      )}
      {expanded && displayContent && (
        <div className="ml-5 mt-0.5">
          <pre className={cn(
            "text-[12px] bg-input rounded px-2 py-1.5 whitespace-pre-wrap break-words overflow-auto max-h-40 font-mono",
            msg.isError ? "text-accent-red/80" : "text-muted-foreground",
          )}>
            {displayContent}
          </pre>
          {isTruncated && (
            <ShowFullContentButton loading={loading} error={error} onClick={loadFullContent} />
          )}
        </div>
      )}
    </div>
  );
});

/** 연속된 tool 메시지를 하나로 묶어 표시하는 그룹 컴포넌트 */
const ToolCallGroup = memo(function ToolCallGroup({ messages }: { messages: ChatMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  const hasError = messages.some((m) => m.isError);
  const allDone = messages.every((m) => m.toolResult !== undefined || m.toolDurationMs !== undefined);

  return (
    <div className="flex gap-2 px-3 py-0.5" data-tree-node-id={messages[0].treeNodeId}>
      <span className="w-8 shrink-0" />
      <div className="flex-1 min-w-0">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[13px] text-muted-foreground hover:text-foreground flex items-center gap-1.5"
        >
          <span className="text-[11px]">{expanded ? "\u25BC" : "\u25B6"}</span>
          <span>{"\u{1F527}"}</span>
          <span className="font-medium">Tool Calls ({messages.length})</span>
          {hasError && <span className="text-accent-red text-[10px]">{"\u25CF"} error</span>}
          {!hasError && allDone && <span className="text-success text-[10px]">{"\u25CF"} done</span>}
        </button>
        {expanded && (
          <div className="ml-4 mt-1 space-y-0.5">
            {messages.map((msg) => (
              <ToolCallItem key={msg.id} msg={msg} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

/** 단일 tool 메시지 (그룹에 속하지 않는 단독 tool) */
const ToolMessage = memo(function ToolMessage({ msg }: { msg: ChatMessage }) {
  return (
    <div className="flex gap-2 px-3 py-0.5" data-tree-node-id={msg.treeNodeId}>
      <span className="w-8 shrink-0" />
      <div className={cn(
        "flex-1 min-w-0 flex items-center gap-1",
        "text-[12px] font-mono truncate",
        msg.isError ? "text-accent-red" : "text-muted-foreground",
      )}>
        <span>{"\u{1F527}"}</span>
        <span className="truncate">{msg.content}</span>
      </div>
    </div>
  );
});

const SystemMessage = memo(function SystemMessage({ msg }: { msg: ChatMessage }) {
  const isError = msg.isError;
  const isResult = msg.treeNodeType === "result";
  const isComplete = msg.treeNodeType === "complete";

  // complete 노드: thinking과 동일한 접기/펼치기 컴포넌트 사용
  if (isComplete && msg.content && msg.content !== "Turn completed") {
    return (
      <div className="flex gap-2 px-3 py-1.5" data-tree-node-id={msg.treeNodeId}>
        <span className="w-8 shrink-0" />
        <div className="flex-1 min-w-0">
          <CollapsibleContent content={msg.content} label={"\u2705 Complete"} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2 px-3 py-1" data-tree-node-id={msg.treeNodeId}>
      <span className="w-8 shrink-0" />
      <div className={cn(
        "flex-1 min-w-0 text-[12px] px-2 py-1 rounded text-center",
        isError
          ? "text-accent-red bg-accent-red/8"
          : isResult
            ? "text-success bg-success/8"
            : "text-muted-foreground bg-input",
      )}>
        {msg.content}
      </div>
    </div>
  );
});

// === ChatInputRequest Component ===

const ChatInputRequest = memo(function ChatInputRequest({
  msg,
  sessionId,
}: {
  msg: ChatMessage;
  sessionId: string;
}) {
  const { remainingSec, isExpired } = useInputRequestTimer(msg.receivedAt, msg.timeoutSec ?? 300);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);

  const question: InputRequestQuestion | undefined = msg.questions?.[0];
  if (!question) return null;

  const handleSelect = async (answer: string) => {
    if (selectedAnswer || msg.responded || msg.expired || isExpired) return;
    if (!msg.requestId) return;
    setSelectedAnswer(answer);  // 낙관적 UI
    const success = await submitInputResponse(
      sessionId,
      msg.requestId,
      msg.id,
      question.question,
      answer
    );
    if (!success) {
      setSelectedAnswer(null);  // 실패 시 롤백
    }
  };

  const isDisabled = !!selectedAnswer || !!msg.responded || !!msg.expired || isExpired;
  const isDone = !!selectedAnswer || !!msg.responded;
  const isTimedOut = msg.expired || (isExpired && !isDone);

  return (
    <div className="flex gap-2 px-3 py-1.5" data-tree-node-id={msg.treeNodeId}>
      <span className="w-8 shrink-0 text-center">🔔</span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-muted-foreground mb-1">Claude가 질문합니다</div>
        {question.header && (
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">{question.header}</div>
        )}
        <div className="text-[14px] font-medium text-foreground mb-2">{question.question}</div>
        {isTimedOut ? (
          <div className="text-[12px] text-muted-foreground">⏱️ 시간 초과</div>
        ) : isDone ? (
          <div className="text-[12px] text-success">✅ {selectedAnswer || '응답 완료'}</div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {question.options?.map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => handleSelect(opt.label)}
                  disabled={isDisabled}
                  className={cn(
                    "px-3 py-1 rounded text-[12px] border transition-colors",
                    "border-border bg-input text-foreground",
                    "hover:bg-muted/50 disabled:opacity-50 disabled:cursor-default",
                  )}
                >
                  {opt.label}
                  {opt.description && (
                    <span className="text-muted-foreground ml-1 text-[11px]">— {opt.description}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="text-[11px] text-muted-foreground">⏱️ {formatTime(remainingSec)}</div>
          </>
        )}
      </div>
    </div>
  );
});

// === ChatMessage Renderer ===

const ChatMessageItem = memo(function ChatMessageItem({ msg, llmContext, sessionId }: { msg: ChatMessage; llmContext?: LlmContext; sessionId?: string }) {
  switch (msg.role) {
    case "user":
      return <UserMessage msg={msg} llmContext={llmContext} />;
    case "intervention":
      return <InterventionMessage msg={msg} />;
    case "assistant":
      // thinking 노드와 text 노드를 독립 컴포넌트로 분리
      return msg.treeNodeType === "thinking"
        ? <ThinkingMessage msg={msg} />
        : <AssistantMessage msg={msg} llmContext={llmContext} />;
    case "tool":
      return <ToolMessage msg={msg} />;
    case "system":
      return <SystemMessage msg={msg} />;
    case "input_request":
      return sessionId ? <ChatInputRequest msg={msg} sessionId={sessionId} /> : null;
    default:
      return null;
  }
});

// === Virtualized Item ===

const VirtualizedItem = memo(function VirtualizedItem({
  vi,
  item,
  measureElement,
  llmContext,
  sessionId,
}: {
  vi: VirtualItem;
  item: MessageOrGroup;
  measureElement: (el: HTMLElement | null) => void;
  llmContext?: LlmContext;
  sessionId?: string;
}) {
  return (
    <div
      ref={measureElement}
      data-index={vi.index}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${vi.start}px)`,
      }}
    >
      {item.type === "tool-group" ? (
        <ToolCallGroup messages={item.messages} />
      ) : (
        <ChatMessageItem msg={item.msg} llmContext={llmContext} sessionId={sessionId} />
      )}
    </div>
  );
});

// === ChatView ===

interface ChatViewProps {
  chatInputDisabled?: boolean;
}
export function ChatView({ chatInputDisabled = false }: ChatViewProps = {}) {
  const tree = useDashboardStore((s) => s.tree);
  const treeVersion = useDashboardStore((s) => s.treeVersion);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const focusEventId = useDashboardStore((s) => s.focusEventId);
  const setFocusEventId = useDashboardStore((s) => s.setFocusEventId);
  const llmContext = useLlmContext();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const messages = useMemo(() => flattenTree(tree), [tree, treeVersion]);
  const grouped = useMemo(() => groupMessages(messages), [messages]);

  // === Virtualizer ===
  const virtualizer = useVirtualizer({
    count: grouped.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    overscan: 5,
  });

  // === Follow mode ===
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isFollowing, setIsFollowing] = useState(true);
  const [showNewMessage, setShowNewMessage] = useState(false);
  const prevTreeVersion = useRef(treeVersion);
  // ref로 effect 내부에서 최신 상태를 참조 (effect deps에서 제거하여 불필요한 재실행 방지)
  const isFollowingRef = useRef(true);
  useEffect(() => { isFollowingRef.current = isFollowing; }, [isFollowing]);
  // 프로그래밍 스크롤 중 scroll 이벤트가 follow를 해제하지 않도록 가드
  const isProgrammaticScroll = useRef(false);

  const checkScrollPosition = useCallback(() => {
    // 프로그래밍 스크롤 중에는 follow 해제하지 않음
    if (isProgrammaticScroll.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_THRESHOLD;
    if (atBottom && !isFollowingRef.current) {
      // 사용자가 직접 맨 아래로 스크롤하면 follow 재활성화
      setIsFollowing(true);
      setShowNewMessage(false);
    } else if (!atBottom && isFollowingRef.current) {
      setIsFollowing(false);
    }
  }, []);

  // 새 이벤트 시: following이면 스크롤, 아니면 "New Messages" 배너 표시
  useEffect(() => {
    if (treeVersion === prevTreeVersion.current) return;
    prevTreeVersion.current = treeVersion;

    if (isFollowingRef.current && grouped.length > 0) {
      isProgrammaticScroll.current = true;
      virtualizer.scrollToIndex(grouped.length - 1, { align: "end" });
      const scrollEl = scrollRef.current;
      if (scrollEl) {
        scrollEl.addEventListener("scrollend", () => {
          isProgrammaticScroll.current = false;
        }, { once: true });
        // fallback: scrollend가 발생하지 않는 경우 (스크롤 없이 콘텐츠 추가 등)
        setTimeout(() => { isProgrammaticScroll.current = false; }, 150);
      }
    } else if (!isFollowingRef.current) {
      setShowNewMessage(true);
    }
  }, [treeVersion]);

  // 세션 변경 시: follow 리셋
  // isProgrammaticScroll 가드: 프로그래매틱 스크롤이 checkScrollPosition을 트리거하여
  // 방금 켠 isFollowing을 다시 끄는 경쟁 조건을 방지한다.
  useEffect(() => {
    setIsFollowing(true);
    setShowNewMessage(false);
    if (scrollRef.current) {
      isProgrammaticScroll.current = true;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      requestAnimationFrame(() => {
        isProgrammaticScroll.current = false;
      });
    }
  }, [activeSessionKey]);

  // 검색 결과 클릭 시: focusEventId에 해당하는 메시지로 스크롤 + 2초간 하이라이트
  // 가상화 환경: grouped 배열에서 인덱스를 찾아 scrollToIndex로 이동한 후, rAF로 DOM 요소에 하이라이트 적용
  const focusAttemptsRef = useRef(0);
  useEffect(() => {
    if (!focusEventId || !scrollRef.current) return;

    // grouped 배열에서 focusEventId와 매칭되는 인덱스 찾기
    const targetIndex = grouped.findIndex((item) => {
      if (item.type === "tool-group") {
        return item.messages.some((m) => m.eventId === focusEventId || m.treeNodeId?.endsWith(`-${focusEventId}`));
      }
      return item.msg.eventId === focusEventId || item.msg.treeNodeId?.endsWith(`-${focusEventId}`);
    });

    if (targetIndex >= 0) {
      focusAttemptsRef.current = 0;
      isProgrammaticScroll.current = true;
      virtualizer.scrollToIndex(targetIndex, { align: "center" });

      // 스크롤 완료 후 DOM 요소에 하이라이트 적용
      requestAnimationFrame(() => {
        isProgrammaticScroll.current = false;
        const el = scrollRef.current?.querySelector(
          `[data-tree-node-id$="-${focusEventId}"]`,
        ) as HTMLElement | null;
        if (el) {
          el.classList.add("ring-2", "ring-accent-amber", "rounded");
          setTimeout(() => {
            el.classList.remove("ring-2", "ring-accent-amber", "rounded");
            setFocusEventId(null);
          }, 2000);
        } else {
          setFocusEventId(null);
        }
      });
      return;
    }

    // grouped에서 못 찾음: 세션 로딩 중일 수 있으므로 treeVersion 갱신마다 재시도.
    // 최대 20회 시도 후 포기 (text_delta/tool_result 등 DOM 노드가 없는 이벤트 대응).
    focusAttemptsRef.current += 1;
    if (focusAttemptsRef.current >= 20) {
      focusAttemptsRef.current = 0;
      setFocusEventId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusEventId, treeVersion, setFocusEventId, grouped, virtualizer]);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current && grouped.length > 0) {
      isProgrammaticScroll.current = true;
      virtualizer.scrollToIndex(grouped.length - 1, { align: "end", behavior: "smooth" });
      setIsFollowing(true);
      setShowNewMessage(false);
      scrollRef.current.addEventListener("scrollend", () => {
        isProgrammaticScroll.current = false;
      }, { once: true });
      // fallback: scrollend가 발생하지 않는 경우 (이미 맨 아래에 있을 때 등)
      setTimeout(() => { isProgrammaticScroll.current = false; }, 150);
    }
  }, [grouped.length, virtualizer]);

  const toggleFollow = useCallback(() => {
    setIsFollowing((prev) => {
      const next = !prev;
      if (next && scrollRef.current && grouped.length > 0) {
        isProgrammaticScroll.current = true;
        virtualizer.scrollToIndex(grouped.length - 1, { align: "end", behavior: "smooth" });
        setShowNewMessage(false);
        scrollRef.current.addEventListener("scrollend", () => {
          isProgrammaticScroll.current = false;
        }, { once: true });
        // fallback: scrollend가 발생하지 않는 경우 (이미 맨 아래에 있을 때 등)
        setTimeout(() => { isProgrammaticScroll.current = false; }, 150);
      }
      return next;
    });
  }, [grouped.length, virtualizer]);

  if (!activeSessionKey) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-[13px]">
        Select a session to view chat
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Message list */}
      <div
        ref={scrollRef}
        onScroll={checkScrollPosition}
        className="flex-1 overflow-y-auto py-2"
      >
        {messages.length === 0 && (
          <div className="p-5 text-center text-muted-foreground text-[13px]">
            Waiting for events...
          </div>
        )}

        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const item = grouped[vi.index];
            return (
              <VirtualizedItem
                key={vi.key}
                vi={vi}
                item={item}
                measureElement={virtualizer.measureElement}
                llmContext={llmContext}
                sessionId={activeSessionKey ?? undefined}
              />
            );
          })}
        </div>
      </div>

      {/* "New Messages" banner */}
      {showNewMessage && !isFollowing && (
        <div className="relative">
          <button
            onClick={scrollToBottom}
            className="absolute bottom-[var(--panel-inset)] left-1/2 -translate-x-1/2 text-[11px] text-muted-foreground bg-popover/90 border border-border rounded-full px-3 py-1 hover:text-foreground hover:bg-popover transition-colors shadow-sm z-10"
          >
            {"\u2193"} New Messages
          </button>
        </div>
      )}

      {/* Follow toggle button */}
      <div className="relative">
        <button
          onClick={toggleFollow}
          className={cn(
            "absolute bottom-[15px] right-[15px] flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors",
            "border shadow-md z-10",
            isFollowing
              ? "bg-accent-blue/15 border-accent-blue/30 text-accent-blue hover:bg-accent-blue/25"
              : "bg-popover border-border text-muted-foreground hover:bg-input",
          )}
        >
          {"\u2193"} Follow
        </button>
      </div>

      {/* ChatInput */}
      <ChatInput additionalDisabled={chatInputDisabled} />
    </div>
  );
}

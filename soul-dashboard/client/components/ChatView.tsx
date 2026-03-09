/**
 * ChatView - SSE 이벤트를 시간순 채팅 로그로 표시
 *
 * 트리를 flat 메시지 리스트로 변환하여 DM 스타일 채팅 UI로 렌더링합니다.
 * 하단에 ChatInput을 배치하여 인터벤션/리줌 메시지를 전송합니다.
 *
 * 자동 스크롤: 새 이벤트 시 하단으로 스크롤, 사용자가 위로 스크롤하면 비활성화.
 * "↓ 마지막으로" 버튼으로 하단 스크롤 + 자동 스크롤 재활성화.
 */

import { memo, useMemo, useRef, useEffect, useState, useCallback } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { flattenTree, type ChatMessage } from "../lib/flatten-tree";
import { ChatInput } from "./ChatInput";
import { cn } from "../lib/cn";

/** 스크롤 하단 판정 threshold (px) */
const SCROLL_THRESHOLD = 50;

// === Message Components ===

const UserMessage = memo(function UserMessage({ msg }: { msg: ChatMessage }) {
  return (
    <div className="flex gap-2 px-3 py-1.5">
      <span className="text-xs mt-0.5 shrink-0">{"\u{1F464}"}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-semibold text-accent-blue uppercase tracking-wide mb-0.5">User</div>
        <div className="text-[13px] text-foreground whitespace-pre-wrap break-words">{msg.content}</div>
      </div>
    </div>
  );
});

const InterventionMessage = memo(function InterventionMessage({ msg }: { msg: ChatMessage }) {
  return (
    <div className="flex gap-2 px-3 py-1.5">
      <span className="text-xs mt-0.5 shrink-0">{"\u270B"}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-semibold text-accent-orange uppercase tracking-wide mb-0.5">Intervention</div>
        <div className="text-[13px] text-foreground whitespace-pre-wrap break-words">{msg.content}</div>
      </div>
    </div>
  );
});

const AssistantMessage = memo(function AssistantMessage({ msg }: { msg: ChatMessage }) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const hasThinking = msg.thinkingContent && msg.thinkingContent !== msg.content;

  return (
    <div className="flex gap-2 px-3 py-1.5">
      <span className="text-xs mt-0.5 shrink-0">{"\u{1F916}"}</span>
      <div className="flex-1 min-w-0">
        {hasThinking && (
          <button
            onClick={() => setThinkingOpen((v) => !v)}
            className="text-[10px] text-muted-foreground hover:text-foreground mb-0.5 flex items-center gap-1"
          >
            <span className="text-[9px]">{thinkingOpen ? "\u25BC" : "\u25B6"}</span>
            Thinking
          </button>
        )}
        {hasThinking && thinkingOpen && (
          <pre className="text-[11px] text-muted-foreground bg-input rounded px-2 py-1.5 mb-1.5 whitespace-pre-wrap break-words overflow-auto max-h-40 font-mono">
            {msg.thinkingContent}
          </pre>
        )}
        <div className="text-[13px] text-foreground whitespace-pre-wrap break-words">
          {msg.content}
          {msg.isStreaming && <span className="inline-block w-1.5 h-3.5 bg-foreground/60 ml-0.5 animate-pulse" />}
        </div>
      </div>
    </div>
  );
});

const ToolMessage = memo(function ToolMessage({ msg }: { msg: ChatMessage }) {
  return (
    <div className="flex gap-2 px-3 py-0.5">
      <span className="text-xs mt-0.5 shrink-0">{"\u{1F527}"}</span>
      <div
        className={cn(
          "text-[11px] font-mono truncate",
          msg.isError ? "text-accent-red" : "text-muted-foreground",
        )}
      >
        {msg.content}
      </div>
    </div>
  );
});

const SystemMessage = memo(function SystemMessage({ msg }: { msg: ChatMessage }) {
  const isError = msg.isError;
  const isResult = msg.treeNodeType === "result";

  return (
    <div className="px-3 py-1">
      <div
        className={cn(
          "text-[11px] px-2 py-1 rounded text-center",
          isError
            ? "text-accent-red bg-accent-red/8"
            : isResult
              ? "text-success bg-success/8"
              : "text-muted-foreground bg-input",
        )}
      >
        {msg.content}
      </div>
    </div>
  );
});

// === ChatMessage Renderer ===

const ChatMessageItem = memo(function ChatMessageItem({ msg }: { msg: ChatMessage }) {
  switch (msg.role) {
    case "user":
      return <UserMessage msg={msg} />;
    case "intervention":
      return <InterventionMessage msg={msg} />;
    case "assistant":
      return <AssistantMessage msg={msg} />;
    case "tool":
      return <ToolMessage msg={msg} />;
    case "system":
      return <SystemMessage msg={msg} />;
    default:
      return null;
  }
});

// === ChatView ===

export function ChatView() {
  const tree = useDashboardStore((s) => s.tree);
  const treeVersion = useDashboardStore((s) => s.treeVersion);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const messages = useMemo(() => flattenTree(tree), [tree, treeVersion]);

  // === Auto-scroll ===
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAutoScroll = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const checkScrollPosition = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_THRESHOLD;
    isAutoScroll.current = atBottom;
    setShowScrollBtn(!atBottom);
  }, []);

  // 새 이벤트 시 자동 스크롤
  useEffect(() => {
    if (isAutoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [treeVersion]);

  // 세션 변경 시 스크롤 리셋
  useEffect(() => {
    isAutoScroll.current = true;
    setShowScrollBtn(false);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeSessionKey]);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
      isAutoScroll.current = true;
      setShowScrollBtn(false);
    }
  }, []);

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

        {messages.map((msg) => (
          <ChatMessageItem key={msg.id} msg={msg} />
        ))}
      </div>

      {/* "↓ 마지막으로" button */}
      {showScrollBtn && (
        <div className="relative">
          <button
            onClick={scrollToBottom}
            className="absolute bottom-[var(--panel-inset)] left-1/2 -translate-x-1/2 text-[11px] text-muted-foreground bg-popover/90 border border-border rounded-full px-3 py-1 hover:text-foreground hover:bg-popover transition-colors shadow-sm z-10"
          >
            {"\u2193"} 마지막으로
          </button>
        </div>
      )}

      {/* ChatInput */}
      <ChatInput />
    </div>
  );
}

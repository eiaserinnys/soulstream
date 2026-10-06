import { useState } from "react";
import { ChatMessageItem } from "@seosoyoung/soul-ui/components/chat/ChatMessageItem";
import { VirtualizedItem } from "@seosoyoung/soul-ui/components/chat/VirtualizedItem";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";

function message(
  id: string,
  role: ChatMessage["role"],
  treeNodeType: string,
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content,
    treeNodeId: `review-${id}`,
    treeNodeType,
    ...extra,
  } as ChatMessage;
}

const completedTools: ChatMessage[] = [
  message("tool-read", "tool", "tool", "mcp__soulstream__Read", {
    toolName: "mcp__soulstream__Read",
    toolDurationMs: 1_200,
    toolResult: "읽기 완료",
  }),
  message("thought-run", "assistant", "thinking", "파일 구조를 확인합니다.", {
    thinkingContent: "파일 구조를 확인합니다.",
  }),
  message("tool-search", "tool", "tool", "mcp__soulstream__Search", {
    toolName: "mcp__soulstream__Search",
    toolDurationMs: 2_400,
    toolResult: "검색 완료",
  }),
];

const singleTool: ChatMessage[] = [
  message("tool-single", "tool", "tool", "mcp__soulstream__Read", {
    toolName: "mcp__soulstream__Read",
    toolDurationMs: 820,
    toolResult: "읽기 완료",
  }),
];

const failedTools: ChatMessage[] = [
  message("tool-running", "tool", "tool", "mcp__soulstream__Search", {
    toolName: "mcp__soulstream__Search",
  }),
  message("tool-failed", "tool", "tool", "mcp__soulstream__Fetch", {
    toolName: "mcp__soulstream__Fetch",
    toolDurationMs: 3_600,
    toolResult: "요청 실패",
    isError: true,
  }),
];

function ActivitySample({ messages, initiallyExpanded }: { messages: ChatMessage[]; initiallyExpanded: boolean }) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  return (
    <VirtualizedItem
      item={{ type: "activity-group", messages }}
      presentation="manuscript"
      toolGroupExpanded={expanded}
      toolGroupKey={messages[0].id}
      onToolGroupExpandedChange={(_key, nextExpanded) => setExpanded(nextExpanded)}
    />
  );
}

export function ManuscriptActivityReviewSample() {
  return (
    <div data-testid="manuscript-activity-review-sample" className="w-full space-y-3 bg-[var(--persistent-session-paper)] p-4">
      <div className="text-xs text-muted-foreground">도구 2회 + 생각 · 펼침</div>
      <ActivitySample messages={completedTools} initiallyExpanded />
      <div className="text-xs text-muted-foreground">도구 1회 · 접힘</div>
      <ActivitySample messages={singleTool} initiallyExpanded={false} />
      <div className="text-xs text-muted-foreground">생각만 있는 구간</div>
      <ChatMessageItem
        msg={message("thought-alone", "assistant", "thinking", "생각만 이어지는 구간은 원고형 문단으로 놓입니다.", {
          thinkingContent: "생각만 이어지는 구간은 원고형 문단으로 놓입니다.",
        })}
        presentation="manuscript"
      />
      <div className="text-xs text-muted-foreground">실행 중 · 실패 1</div>
      <ActivitySample messages={failedTools} initiallyExpanded />
      <div className="text-xs text-muted-foreground">생각 중</div>
      <VirtualizedItem item={{ type: "thinking-indicator" }} presentation="manuscript" />
    </div>
  );
}

import { memo } from "react";
import type { ReactNode } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import type { LlmContext } from "./hooks";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { ThinkingMessage } from "./ThinkingMessage";
import { InterventionMessage } from "./InterventionMessage";
import { SystemPromptMessage } from "./SystemPromptMessage";
import { SystemMessage } from "./SystemMessage";
import { ToolMessage } from "./ToolMessage";
import { ChatInputRequest } from "./ChatInputRequest";
import { AwaySummaryMessage } from "./AwaySummaryMessage";

/**
 * 모듈 범위의 seen 집합.
 *
 * 이미 1회 이상 렌더된 메시지 id를 기록하여, 같은 메시지가 virtual scroll
 * unmount → remount 되어도 enter 애니메이션이 재생되지 않도록 보장한다.
 * ChatMessageItem 전체가 동일한 채팅 타임라인을 공유하므로 모듈 범위가 적절하다.
 */
const seenChatMessageIds = new Set<string>();

function shouldAnimateEnter(key: string): boolean {
  if (seenChatMessageIds.has(key)) return false;
  seenChatMessageIds.add(key);
  return true;
}

/** 메시지 타입에 따라 적절한 컴포넌트로 라우팅 */
export const ChatMessageItem = memo(function ChatMessageItem({ msg, llmContext, sessionId }: { msg: ChatMessage; llmContext?: LlmContext; sessionId?: string }) {
  let body: ReactNode;
  switch (msg.role) {
    case "user":
      body = <UserMessage msg={msg} llmContext={llmContext} />;
      break;
    case "intervention":
      body = <InterventionMessage msg={msg} />;
      break;
    case "assistant":
      // thinking 노드와 text 노드를 독립 컴포넌트로 분리
      body = msg.treeNodeType === "thinking"
        ? <ThinkingMessage msg={msg} />
        : <AssistantMessage msg={msg} llmContext={llmContext} />;
      break;
    case "tool":
      body = <ToolMessage msg={msg} />;
      break;
    case "system":
      body = <SystemMessage msg={msg} />;
      break;
    case "system_message":
      body = <SystemPromptMessage msg={msg} />;
      break;
    case "input_request":
      body = sessionId ? <ChatInputRequest msg={msg} sessionId={sessionId} /> : null;
      break;
    case "away_summary":
      body = <AwaySummaryMessage msg={msg} />;
      break;
    default:
      return null;
  }

  if (body == null) return null;

  const animate = shouldAnimateEnter(msg.id);
  return <div className={animate ? "message-enter" : undefined}>{body}</div>;
});

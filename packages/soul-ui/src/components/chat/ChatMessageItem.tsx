import { memo } from "react";
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

/** 메시지 타입에 따라 적절한 컴포넌트로 라우팅 */
export const ChatMessageItem = memo(function ChatMessageItem({ msg, llmContext, sessionId }: { msg: ChatMessage; llmContext?: LlmContext; sessionId?: string }) {
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
    case "system_message":
      return <SystemPromptMessage msg={msg} />;
    case "input_request":
      return sessionId ? <ChatInputRequest msg={msg} sessionId={sessionId} /> : null;
    default:
      return null;
  }
});

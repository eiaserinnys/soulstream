import { memo, useState } from "react";
import type { ReactNode } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import type { ChatAttachmentItem } from "../../lib/chat-attachment-model";
import { useChatAttachments } from "../../hooks/useChatAttachments";
import { AttachmentViewer } from "../AttachmentViewer";
import { Button } from "../ui/button";
import { ChatAttachments } from "./ChatAttachments";
import type { LlmContext } from "./hooks";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { ThinkingMessage } from "./ThinkingMessage";
import { InterventionMessage } from "./InterventionMessage";
import { SystemPromptMessage } from "./SystemPromptMessage";
import { SystemMessage } from "./SystemMessage";
import { ToolMessage } from "./ToolMessage";
import { ChatInputRequest } from "./ChatInputRequest";
import { ChatToolApproval } from "./ChatToolApproval";
import { AwaySummaryMessage } from "./AwaySummaryMessage";
import { ChatUiMessage, isSupportedChatUiPublication } from "../chat-ui/ChatUiMessage";

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

function filterDisplayedAttachments(msg: ChatMessage, items: ChatAttachmentItem[]): ChatAttachmentItem[] {
  if (msg.attachmentDisplayIds === undefined) return items;
  const allowedIds = new Set(msg.attachmentDisplayIds);
  return items.filter((item) => {
    if (item.source.kind === "asset") return allowedIds.has(item.source.attachmentId);
    if (item.source.kind === "unavailable" && item.source.attachmentId !== undefined) {
      return allowedIds.has(item.source.attachmentId);
    }
    return true;
  });
}

/** 메시지 타입에 따라 적절한 컴포넌트로 라우팅 */
export const ChatMessageItem = memo(function ChatMessageItem({ msg, llmContext, sessionId, presentation = "default", narration = false }: { msg: ChatMessage; llmContext?: LlmContext; sessionId?: string; presentation?: "default" | "manuscript"; narration?: boolean }) {
  const hasAttachmentSignal = msg.role === "user" || msg.role === "intervention" || msg.role === "assistant"
    ? Boolean(msg.attachmentIds?.length || msg.attachmentPaths?.length || msg.attachmentCount || msg.attachmentDisplayIds?.length)
    : false;
  const eventId = Number.isSafeInteger(msg.eventId) && (msg.eventId ?? 0) > 0 ? msg.eventId! : 0;
  const attachmentState = useChatAttachments({
    sessionId: sessionId ?? "",
    eventId,
    enabled: Boolean(sessionId && eventId && hasAttachmentSignal),
  });
  const attachmentItems = filterDisplayedAttachments(msg, attachmentState.items);
  const projectedOutputRow = msg.id.startsWith("output-attachments:");
  const [viewer, setViewer] = useState<{ index: number; trigger: HTMLElement } | null>(null);
  const attachmentRole = msg.role === "assistant" ? "assistant" : "user";
  let attachmentSlot: ReactNode = null;
  if (attachmentItems.length > 0) {
    attachmentSlot = <ChatAttachments
      items={attachmentItems}
      role={attachmentRole}
      onOpen={(index, trigger) => setViewer({ index, trigger })}
    />;
  } else if (attachmentState.loading) {
    attachmentSlot = <div className="chat-image-run" data-chat-image-role={attachmentRole} data-chat-attachment-state="loading">
      <div className="chat-image-frame"><span className="chat-image-status" role="status">첨부 불러오는 중…</span></div>
    </div>;
  } else if (attachmentState.error) {
    const retryable = attachmentState.error === "첨부 정보를 불러오지 못했습니다. 다시 시도해 주세요."
      || attachmentState.error === "연결을 확인한 뒤 첨부를 다시 불러와 주세요.";
    attachmentSlot = <div className="chat-image-run" data-chat-image-role={attachmentRole} data-chat-attachment-state="error">
      <div className="chat-image-frame">
        <span className="chat-image-status" role="status">{attachmentState.error}</span>
        {retryable && <Button variant="outline" size="sm" onClick={attachmentState.reload}>다시 시도</Button>}
      </div>
    </div>;
  }

  if (projectedOutputRow && !attachmentState.loading && attachmentState.error === null && attachmentItems.length === 0) {
    return null;
  }

  let body: ReactNode;
  switch (msg.role) {
    case "user":
      body = <UserMessage
        msg={msg}
        llmContext={llmContext}
        presentation={presentation}
        attachments={attachmentSlot}
        representedAttachments={attachmentItems}
        readContext={sessionId ? { type: "session", id: sessionId } : undefined}
      />;
      break;
    case "intervention":
      body = <InterventionMessage msg={msg} presentation={presentation} attachments={attachmentSlot} />;
      break;
    case "assistant":
      // thinking 노드와 text 노드를 독립 컴포넌트로 분리
      body = msg.treeNodeType === "thinking"
        ? <ThinkingMessage msg={msg} presentation={presentation} />
        : msg.ui !== undefined
          ? <AssistantMessage
            msg={msg}
            llmContext={llmContext}
            presentation={presentation}
            narration={false}
            contentLayout={isSupportedChatUiPublication(msg.ui) ? "structured" : "text"}
            attachments={attachmentSlot}
            representedAttachments={attachmentItems}
            readContext={sessionId ? { type: "session", id: sessionId } : undefined}
          >
            <ChatUiMessage ui={msg.ui} content={msg.content} presentation={presentation} />
          </AssistantMessage>
          : <AssistantMessage
            msg={msg}
            llmContext={llmContext}
            presentation={presentation}
            narration={narration}
            attachments={attachmentSlot}
            representedAttachments={attachmentItems}
            readContext={sessionId ? { type: "session", id: sessionId } : undefined}
          />;
      break;
    case "tool":
      body = <ToolMessage msg={msg} />;
      break;
    case "system":
      body = <SystemMessage msg={msg} presentation={presentation} />;
      break;
    case "system_message":
      body = <SystemPromptMessage msg={msg} />;
      break;
    case "notification":
      body = <SystemMessage msg={msg} presentation={presentation} />;
      break;
    case "input_request":
      body = sessionId ? <ChatInputRequest msg={msg} sessionId={sessionId} presentation={presentation} /> : null;
      break;
    case "tool_approval":
      body = sessionId ? <ChatToolApproval msg={msg} sessionId={sessionId} presentation={presentation} /> : null;
      break;
    case "away_summary":
      body = <AwaySummaryMessage msg={msg} />;
      break;
    default:
      return null;
  }

  if (body == null) return null;

  const animate = shouldAnimateEnter(msg.id);
  return <div className={animate ? "message-enter" : undefined} data-slot={presentation === "manuscript" ? "chat-manuscript-message" : undefined} data-chat-presentation={presentation === "manuscript" ? "manuscript" : undefined}>
    {body}
    <AttachmentViewer
      items={attachmentItems}
      index={viewer?.index ?? null}
      onIndexChange={index => setViewer(current => current ? { ...current, index } : null)}
      onClose={() => setViewer(null)}
      returnFocus={viewer?.trigger}
    />
  </div>;
});

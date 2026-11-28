import { useTranslation } from "react-i18next";
import { removeRepresentedAttachmentPathNotes } from "../../lib/attachment-path-notes";
import { stripEventTruncationSuffix } from "../../lib/event-truncation-display";
import { memo, useState, type ReactNode } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import type { ChatAttachmentItem } from "../../lib/chat-attachment-model";
import { useChatAttachments } from "../../hooks/useChatAttachments";
import { AttachmentViewer } from "../AttachmentViewer";
import { Button } from "../ui/button";
import { ChatAttachments } from "./ChatAttachments";
import type { LlmContext } from "./hooks";
import { UserMessage } from "./UserMessage";
import type { DeliveryFailureActions } from "./DeliveryFailureBlock";
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
  const truncationAttachmentId = msg.truncation?.attachment?.attachment_id;
  if (msg.attachmentDisplayIds === undefined && truncationAttachmentId === undefined) return items;
  const allowedIds = msg.attachmentDisplayIds === undefined ? null : new Set(msg.attachmentDisplayIds);
  return items.filter((item) => {
    const attachmentId = item.source.kind === "asset" || item.source.kind === "unavailable"
      ? item.source.attachmentId
      : undefined;
    if (truncationAttachmentId !== undefined && attachmentId === truncationAttachmentId) return false;
    if (allowedIds === null) return true;
    if (attachmentId !== undefined) {
      return allowedIds.has(attachmentId);
    }
    return true;
  });
}

/** 메시지 타입에 따라 적절한 컴포넌트로 라우팅 */
export const ChatMessageItem = memo(function ChatMessageItem({ msg, llmContext, sessionId, presentation = "default", narration = false, deliveryFailures, onRetryDelivery, onRestoreDelivery }: {
  msg: ChatMessage;
  llmContext?: LlmContext;
  sessionId?: string;
  presentation?: "default" | "manuscript";
  narration?: boolean;
  /** input_id -> 실패 사유. 사람 발신 dead_letter만 서버가 넣어 준다. */
  deliveryFailures?: Readonly<Record<string, string>>;
  onRetryDelivery?: (message: { text: string; attachmentPaths: readonly string[] }) => void;
  onRestoreDelivery?: (text: string) => void;
}) {
  const { t } = useTranslation();
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
  msg = {
    ...msg,
    content: removeRepresentedAttachmentPathNotes(
      stripEventTruncationSuffix(msg.content, msg.truncation),
      attachmentItems,
    ),
  };
  // 카드 #1524: 전달 장부에서 실패로 닫힌 사람 발신 말풍선만 실패 줄과 단추를 단다.
  // 첨부가 있는데 그 경로를 이벤트에서 얻지 못하면 다시 보내기는 숨기고 복원만 남긴다.
  const deliveryFailure: DeliveryFailureActions | undefined = (() => {
    if (msg.inputId === undefined) return undefined;
    if (deliveryFailures?.[msg.inputId] === undefined) return undefined;
    const hasAttachmentsWithoutPaths = hasAttachmentSignal
      && (msg.attachmentPaths === undefined || msg.attachmentPaths.length === 0);
    return {
      onRetry: hasAttachmentsWithoutPaths || !onRetryDelivery
        ? undefined
        : () => onRetryDelivery({ text: msg.content, attachmentPaths: msg.attachmentPaths ?? [] }),
      onRestore: onRestoreDelivery ? () => onRestoreDelivery(msg.content) : undefined,
    };
  })();
  const attachmentTone = presentation === "default" && msg.role !== "assistant" ? "onUserBubble" as const : undefined;
  const projectedOutputRow = msg.id.startsWith("output-attachments:");
  const [viewer, setViewer] = useState<{ index: number; trigger: HTMLElement } | null>(null);
  const attachmentRole = msg.role === "assistant" ? "assistant" : "user";
  let attachmentSlot: ReactNode = null;
  if (attachmentItems.length > 0) {
    attachmentSlot = <ChatAttachments
      items={attachmentItems}
      role={attachmentRole}
      tone={attachmentTone}
      onOpen={(index, trigger) => setViewer({ index, trigger })}
    />;
  } else if (attachmentState.loading) {
    attachmentSlot = <div className="chat-image-run" data-chat-image-role={attachmentRole} data-chat-attachment-tone={attachmentTone} data-chat-attachment-state="loading">
      <div className="chat-image-frame"><span className="chat-image-status" role="status">{t("ui.attachment.loading")}</span></div>
    </div>;
  } else if (attachmentState.error) {
    const { retryable } = attachmentState;
    attachmentSlot = <div className="chat-image-run" data-chat-image-role={attachmentRole} data-chat-attachment-tone={attachmentTone} data-chat-attachment-state="error">
      <div className="chat-image-frame">
        <span className="chat-image-status" role="status">{retryable ? t("ui.attachment.metadataFailed") : attachmentState.error}</span>
        {retryable && <Button variant="outline" size="sm" onClick={attachmentState.reload}>{t("ui.common.retry")}</Button>}
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
        {...(deliveryFailure ? { deliveryFailure } : {})}
      />;
      break;
    case "intervention":
      body = <InterventionMessage msg={msg} presentation={presentation} attachments={attachmentSlot} {...(deliveryFailure ? { deliveryFailure } : {})} />;
      break;
    case "assistant":
      // thinking 노드와 text 노드를 독립 컴포넌트로 분리
      body = msg.treeNodeType === "thinking"
        ? <ThinkingMessage msg={msg} presentation={presentation} sessionId={sessionId} />
        : msg.ui !== undefined
          ? <AssistantMessage
            msg={msg}
            llmContext={llmContext}
            sessionId={sessionId}
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
            sessionId={sessionId}
            presentation={presentation}
            narration={narration}
            attachments={attachmentSlot}
            representedAttachments={attachmentItems}
            readContext={sessionId ? { type: "session", id: sessionId } : undefined}
          />;
      break;
    case "tool":
      body = <ToolMessage msg={msg} sessionId={sessionId} />;
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

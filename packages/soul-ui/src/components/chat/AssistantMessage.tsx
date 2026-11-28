import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { memo, useEffect, useRef, type ReactNode, type HTMLAttributes } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import type { ChatAttachmentItem } from "../../lib/chat-attachment-model";
import type { AttachmentReadContext } from "@soulstream/wire-schema/attachments";
import { useChatStore } from "../../stores/chat-store-scope";
import { ProfileAvatar } from "../ProfileAvatar";
import { MarkdownContent } from "../MarkdownContent";
import {
  markdownBodyClass,
  markdownManuscriptBodyClass,
  markdownPlainBodyClass,
} from "../markdown-classes";
import { stripEventTruncationSuffix } from "../../lib/event-truncation-display";
import { useGlassSurface } from "../LiquidGlassProvider";
import type { LlmContext } from "./hooks";
import { EventTruncationMetadata } from "./EventTruncationMetadata";
import { StreamingMarkdown, preloadStreamingMarkdown } from "./StreamingMarkdown";

/** text 노드: 일반 텍스트 표시 */
export const AssistantMessage = memo(function AssistantMessage({
  msg,
  llmContext,
  header,
  children,
  attachments,
  representedAttachments,
  readContext,
  sessionId,
  portraitUrl,
  bubbleProps,
  presentation = "default",
  contentLayout = "text",
  narration = false,
}: {
  msg: ChatMessage;
  llmContext?: LlmContext;
  header?: ReactNode;
  children?: ReactNode;
  attachments?: ReactNode;
  representedAttachments?: readonly ChatAttachmentItem[];
  readContext?: AttachmentReadContext;
  sessionId?: string;
  portraitUrl?: string | null;
  bubbleProps?: HTMLAttributes<HTMLDivElement>;
  presentation?: "default" | "manuscript";
  narration?: boolean;
  contentLayout?: "text" | "structured";
}) {
  const { t, i18n } = useTranslation();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const manuscript = presentation === "manuscript";

  // 채팅 본문이 화면에 올라오면 스트리밍용 words 모듈을 미리 받아 둔다.
  // 스트리밍이 시작된 뒤에 받기 시작하면 첫 부분이 평문으로 보인다.
  useEffect(() => {
    void preloadStreamingMarkdown();
  }, []);
  const webglActive = useGlassSurface(bubbleRef, { enabled: !manuscript });
  const activeSession = useChatStore((s) => s.activeSessionSummary);

  // 세션에 바인딩된 에이전트 정보
  const agentName = activeSession?.agentName;
  const agentPortraitUrl = portraitUrl ?? activeSession?.agentPortraitUrl;

  const isLlm = llmContext?.isLlm ?? false;
  // LLM 세션: assistant_message에 model 정보가 있으면 표시, 없으면 llmContext에서 가져옴
  const modelLabel = msg.model ?? llmContext?.llmModel;
  const displayName = isLlm
    ? modelLabel ? t("ui.chat.assistantModel", { model: modelLabel }) : t("ui.chat.assistant")
    : agentName ?? t("ui.chat.assistant");
  const displayId = isLlm ? null : activeSession?.agentId ?? null;
  const hasPortrait = isLlm ? false : !!agentPortraitUrl;
  const bubbleClassName = manuscript
    ? "w-full min-w-0 text-foreground"
    : cn(
      contentLayout === "structured" ? "w-full min-w-0 max-w-[86%]" : "max-w-[86%]",
      "rounded-floor bg-[var(--lg-card)] px-3.5 py-2.5 shadow-[0_6px_20px_-14px_rgb(20_26_40_/_45%)]",
    );

  // 토큰 사용량 (assistant_message 노드에 usage가 있을 때 인라인 표시)
  const tokenInfo = msg.usage
    ? t("ui.chat.tokens", { total: (msg.usage.input_tokens + msg.usage.output_tokens).toLocaleString(i18n.resolvedLanguage) })
    : null;
  const displayContent = stripEventTruncationSuffix(msg.content, msg.truncation);

  return (
    <div className={manuscript ? "flex" : "flex gap-2 px-3 py-1.5"} data-slot="chat-message-row" data-tree-node-id={msg.treeNodeId} data-chat-presentation={manuscript ? "manuscript" : undefined} data-chat-narration={manuscript && narration ? "true" : undefined}>
      {!manuscript && <ProfileAvatar
        role="assistant"
        hasPortrait={hasPortrait}
        fallbackEmoji={"\u{1F916}"}
        portraitUrl={agentPortraitUrl}
      />}
      <div
        ref={bubbleRef}
        {...bubbleProps}
        data-slot="chat-message-bubble"
        data-chat-attachment-role={!manuscript && attachments ? "assistant" : undefined}
        className={cn(bubbleClassName, !manuscript && attachments && "chat-attachment-bubble", bubbleProps?.className)}
        data-liquid-glass-webgl={webglActive ? "true" : undefined}
      >
        {!manuscript && (header ?? <div className="mb-1 flex items-baseline gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {displayName}
          </span>
          {displayId && (
            <span className="text-xs text-muted-foreground/70">
              {displayId}
            </span>
          )}
          {isLlm && tokenInfo && (
            <span className="text-xs text-muted-foreground/70 font-normal normal-case">
              {tokenInfo}
            </span>
          )}
        </div>)}
        {msg.isStreaming ? (
          <StreamingMarkdown content={displayContent} manuscript={manuscript} />
        ) : (
          <div data-slot="chat-body" className={cn(markdownBodyClass, manuscript ? markdownManuscriptBodyClass : markdownPlainBodyClass)}>
          {children ?? (
            <MarkdownContent
              content={displayContent}
              enableBlockquoteCopy
              chatImages={readContext
                ? { role: "assistant", layout: manuscript ? "gallery" : "inline", representedAttachments, readContext }
                : manuscript ? { role: "assistant" } : undefined}
            />
          )}
          </div>
        )}
        <EventTruncationMetadata
          truncation={msg.truncation}
          sessionId={sessionId}
          eventId={msg.eventId}
        />
        {attachments}
      </div>
    </div>
  );
});

import { memo, useRef } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { useDashboardStore } from "../../stores/dashboard-store";
import { ProfileAvatar } from "../ProfileAvatar";
import { MarkdownContent } from "../MarkdownContent";
import { useGlassSurface } from "../LiquidGlassProvider";
import type { LlmContext } from "./hooks";

/** text 노드: 일반 텍스트 표시 */
export const AssistantMessage = memo(function AssistantMessage({ msg, llmContext }: { msg: ChatMessage; llmContext?: LlmContext }) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const webglActive = useGlassSurface(bubbleRef, { enabled: true });
  const activeSession = useDashboardStore((s) => s.activeSessionSummary);

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
    <div className="flex gap-2 px-3 py-1.5" data-slot="chat-message-row" data-tree-node-id={msg.treeNodeId}>
      <ProfileAvatar
        role="assistant"
        hasPortrait={hasPortrait}
        fallbackEmoji={"\u{1F916}"}
        portraitUrl={agentPortraitUrl}
      />
      <div
        ref={bubbleRef}
        data-slot="chat-message-bubble"
        className="max-w-[86%] rounded-[17px] rounded-bl-[7px] bg-[var(--lg-card)] px-3.5 py-2.5 shadow-[0_6px_20px_-14px_rgb(20_26_40_/_45%)]"
        data-liquid-glass-webgl={webglActive ? "true" : undefined}
      >
        <div className="mb-1 flex items-baseline gap-1.5">
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
        </div>
        {msg.isStreaming ? (
          <div className="text-base leading-snug text-foreground whitespace-pre-wrap break-words">
            {msg.content}
            <span className="inline-block w-1.5 h-3.5 bg-foreground/60 ml-0.5 align-text-bottom animate-caret-blink" aria-hidden="true" />
          </div>
        ) : (
          <div className="break-words text-base leading-snug text-foreground">
            <MarkdownContent content={msg.content} />
          </div>
        )}
      </div>
    </div>
  );
});

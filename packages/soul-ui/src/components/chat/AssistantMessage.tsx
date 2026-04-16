import { memo } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { useDashboardStore } from "../../stores/dashboard-store";
import { ProfileAvatar } from "../ProfileAvatar";
import { MarkdownContent } from "../MarkdownContent";
import type { LlmContext } from "./hooks";

/** text 노드: 일반 텍스트 표시 */
export const AssistantMessage = memo(function AssistantMessage({ msg, llmContext }: { msg: ChatMessage; llmContext?: LlmContext }) {
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
    <div className="flex gap-2 px-3 py-1" data-tree-node-id={msg.treeNodeId}>
      <ProfileAvatar
        role="assistant"
        hasPortrait={hasPortrait}
        fallbackEmoji={"\u{1F916}"}
        portraitUrl={agentPortraitUrl}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 mb-0.5">
          <span className="text-base font-bold text-foreground uppercase tracking-wide">
            {displayName}
          </span>
          {displayId && (
            <span className="text-xs text-muted-foreground">
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
          <div className="text-base leading-snug text-foreground break-words">
            <MarkdownContent content={msg.content} />
          </div>
        )}
      </div>
    </div>
  );
});

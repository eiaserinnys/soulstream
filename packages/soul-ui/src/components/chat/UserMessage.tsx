import { memo } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { useDashboardStore } from "../../stores/dashboard-store";
import { ProfileAvatar } from "../ProfileAvatar";
import { MarkdownContent } from "../MarkdownContent";
import { ContextBlock } from "./ContextBlock";
import type { LlmContext } from "./hooks";
import {
  extractCallerAvatarUrl,
  pickMessageAvatarUrl,
} from "./userAvatarSelectors";

export const UserMessage = memo(function UserMessage({ msg, llmContext }: { msg: ChatMessage; llmContext?: LlmContext }) {
  const config = useDashboardStore((s) => s.dashboardConfig);
  const userConfig = config?.user;
  // caller_info v1 (atom ed3a216d): 세션-수준 발신자 신원 avatar_url —
  // 메시지 단위 caller_info(msg.callerInfo) 부재 시 fallback. 4 source(browser/slack/agent/soul-app) 동일 entry.
  const callerAvatarUrl = useDashboardStore((s) =>
    extractCallerAvatarUrl(s.activeSessionSummary?.metadata),
  );

  const isLlm = llmContext?.isLlm ?? false;
  const isAgent = !!msg.agentInfo;

  // 에이전트 발신: agentInfo에서 이름 추출
  const agentDisplayName = isAgent
    ? msg.agentInfo!.agent_name ?? msg.agentInfo!.agent_id ?? "Agent"
    : null;
  const agentDisplayId = isAgent
    ? `${agentDisplayName}@${msg.agentInfo!.agent_node}`
    : null;
  const agentPortraitUrl = isAgent && msg.agentInfo!.agent_id
    ? `/api/nodes/${msg.agentInfo!.agent_node}/agents/${msg.agentInfo!.agent_id}/portrait`
    : null;

  // user 분기 displayName: 메시지 단위 caller_info.display_name 우선 (멀티-소스 세션 정확도 향상).
  const msgCallerDisplayName = msg.callerInfo?.display_name;
  const displayName = isAgent
    ? agentDisplayName ?? "Agent"
    : isLlm
      ? "USER"
      : (typeof msgCallerDisplayName === "string" && msgCallerDisplayName.length > 0)
        ? msgCallerDisplayName
        : userConfig && userConfig.name !== "USER"
          ? `${userConfig.name}`
          : "User";
  const displayId = isAgent ? agentDisplayId : isLlm ? null : userConfig?.id ? `${userConfig.id}` : null;
  // user 발신 portrait: 메시지 caller_info → 세션 caller_info → dashboardConfig 우선순위.
  // 첫 history fetch 시점에도 메시지 단위 caller_info가 함께 도착하므로
  // 세션-수준 metadata propagation race로 인한 미표시 결함이 해소된다 (atom ed3a216d 통합 후속 fix).
  const userPortraitUrl = pickMessageAvatarUrl(
    msg.callerInfo,
    callerAvatarUrl,
    userConfig?.portraitUrl ?? null,
  );
  // hasPortrait는 ProfileAvatar 본문에서 사용되지 않는 dead prop이지만 인터페이스를 위해 유지.
  // user 발신 시 portraitUrl 존재 여부로 결정 (기존 userConfig?.hasPortrait fallback은 ProfileAvatar가 무시하므로 제거).
  const hasPortrait = isAgent ? !!agentPortraitUrl : isLlm ? false : !!userPortraitUrl;

  return (
    <div className="flex justify-end gap-2 px-3 py-1.5" data-slot="chat-message-row" data-tree-node-id={msg.treeNodeId}>
      <div data-slot="chat-message-bubble" className="max-w-[86%] rounded-[17px] rounded-br-[7px] bg-gradient-to-b from-[#2E96FF] to-[#0A84FF] px-3.5 py-2.5 text-white shadow-[0_8px_22px_-10px_rgb(10_132_255_/_55%)]">
        <div className="mb-1 flex items-baseline justify-end gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-white/75">
            {displayName}
          </span>
          {displayId && (
            <span className="text-xs text-white/55">
              {displayId}
            </span>
          )}
        </div>
        <div data-slot="chat-body" className="chat-message-selectable break-words text-base leading-snug text-white [&_code]:bg-white/15 [&_code]:text-white">
          <MarkdownContent content={msg.content} linkTone="onUserBubble" enableBlockquoteCopy />
        </div>
        {msg.contextItems && msg.contextItems.length > 0 && (
          <ContextBlock items={msg.contextItems} />
        )}
      </div>
      <ProfileAvatar
        role="user"
        hasPortrait={hasPortrait}
        fallbackEmoji={isAgent ? "\u{1F916}" : "\u{1F464}"}
        portraitUrl={isAgent ? agentPortraitUrl : userPortraitUrl}
      />
    </div>
  );
});

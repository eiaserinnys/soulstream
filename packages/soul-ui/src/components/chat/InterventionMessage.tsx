import { memo } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { useDashboardStore } from "../../stores/dashboard-store";
import { ProfileAvatar } from "../ProfileAvatar";
import {
  extractCallerAvatarUrl,
  pickMessageAvatarUrl,
} from "./userAvatarSelectors";

/**
 * 인터벤션 메시지 표시 — 2차+ 메시지 발신자 단위 아바타·이름.
 *
 * F-9 fix(2026-05-08, atom beed44e0): 이전엔 dashboardConfig.user의 portrait를
 * 무조건 표시하여 슬랙·soul-app 등 *본인이 아닌 발신자*의 2차+ 메시지가
 * 대시보드 owner의 Google 아바타로 떨어지는 결함이 있었다 (사용자 보고).
 * UserMessage와 동일한 우선순위 fallback 사슬을 도입하여 메시지-단위
 * caller_info 우선, 부재 시 세션-단위 metadata, 그것도 없으면 dashboard 사용자
 * portrait로 다단 fallback 한다.
 */
export const InterventionMessage = memo(function InterventionMessage({ msg }: { msg: ChatMessage }) {
  const config = useDashboardStore((s) => s.dashboardConfig);
  const userConfig = config?.user;
  // 세션-수준 caller_info avatar_url — 메시지 단위 caller_info 부재 시 fallback.
  const callerAvatarUrl = useDashboardStore((s) =>
    extractCallerAvatarUrl(s.activeSessionSummary?.metadata),
  );

  const isAgent = !!msg.agentInfo;

  // 에이전트 발신: agentInfo에서 이름·아바타 도출
  const agentDisplayName = isAgent
    ? msg.agentInfo!.agent_name ?? msg.agentInfo!.agent_id ?? "Agent"
    : null;
  const agentDisplayId = isAgent
    ? `${agentDisplayName}@${msg.agentInfo!.agent_node}`
    : null;
  const agentPortraitUrl = isAgent && msg.agentInfo!.agent_id
    ? `/api/nodes/${msg.agentInfo!.agent_node}/agents/${msg.agentInfo!.agent_id}/portrait`
    : null;

  // user 분기 displayName: 메시지 단위 caller_info.display_name 우선.
  const msgCallerDisplayName = msg.callerInfo?.display_name;
  const displayName = isAgent
    ? agentDisplayName ?? "Agent"
    : (typeof msgCallerDisplayName === "string" && msgCallerDisplayName.length > 0)
      ? msgCallerDisplayName
      : userConfig && userConfig.name !== "USER"
        ? `${userConfig.name}`
        : "Intervention";
  const displayId = isAgent
    ? agentDisplayId
    : userConfig?.id
      ? `${userConfig.id}`
      : null;

  // 인터벤션 portrait: 메시지 caller_info → 세션 caller_info → dashboardConfig.
  // UserMessage와 동일 우선순위 (정본 하나 §3 — pickMessageAvatarUrl 재사용).
  const userPortraitUrl = pickMessageAvatarUrl(
    msg.callerInfo,
    callerAvatarUrl,
    userConfig?.portraitUrl ?? null,
  );
  const hasPortrait = isAgent ? !!agentPortraitUrl : !!userPortraitUrl;

  return (
    <div className="flex gap-2 px-3 py-1" data-tree-node-id={msg.treeNodeId}>
      <ProfileAvatar
        role="user"
        hasPortrait={hasPortrait}
        fallbackEmoji={isAgent ? "\u{1F916}" : "✋"}
        portraitUrl={isAgent ? agentPortraitUrl : userPortraitUrl}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 mb-0.5">
          <span className="text-base font-bold text-accent-orange uppercase tracking-wide">
            {displayName}
          </span>
          {displayId && (
            <span className="text-xs text-muted-foreground">
              {displayId}
            </span>
          )}
        </div>
        <div className="text-base leading-snug text-foreground whitespace-pre-wrap break-words">{msg.content}</div>
      </div>
    </div>
  );
});

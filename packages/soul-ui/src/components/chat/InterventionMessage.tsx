import { memo } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { useDashboardStore } from "../../stores/dashboard-store";
import { ProfileAvatar } from "../ProfileAvatar";
import { extractCallerAvatarUrl } from "./userAvatarSelectors";
import { computeInterventionDisplay } from "./InterventionMessage.helpers";

/**
 * 인터벤션 메시지 표시 — 2차+ 메시지 발신자 단위 아바타·이름.
 *
 * F-9 fix(2026-05-08, atom beed44e0): 이전엔 dashboardConfig.user의 portrait를
 * 무조건 표시하여 슬랙·soul-app 등 *본인이 아닌 발신자*의 2차+ 메시지가
 * 대시보드 owner의 Google 아바타로 떨어지는 결함이 있었다 (사용자 보고).
 * UserMessage와 동일한 우선순위 fallback 사슬을 도입하여 메시지-단위
 * caller_info 우선, 부재 시 세션-단위 metadata, 그것도 없으면 dashboard 사용자
 * portrait로 다단 fallback 한다.
 *
 * F-11 fix(2026-05-09, atom F-11): source="system" 분기 추가 — soulstream 서버
 * lifecycle 인터벤션(재시작 예고/완료 안내)을 "Soulstream" 이름 + 정적 자산
 * (/system-portrait.png) + ⚙️ fallback으로 표시. 분기 로직은
 * InterventionMessage.helpers의 computeInterventionDisplay로 추출 (design-principles
 * §1 깊이 + §10 인터페이스가 테스트 표면).
 */
export const InterventionMessage = memo(function InterventionMessage({ msg }: { msg: ChatMessage }) {
  const config = useDashboardStore((s) => s.dashboardConfig);
  const userConfig = config?.user;
  // 세션-수준 caller_info avatar_url — 메시지 단위 caller_info 부재 시 fallback.
  const callerAvatarUrl = useDashboardStore((s) =>
    extractCallerAvatarUrl(s.activeSessionSummary?.metadata),
  );

  const display = computeInterventionDisplay(msg, callerAvatarUrl, userConfig);

  return (
    <div className="flex gap-2 px-3 py-1" data-tree-node-id={msg.treeNodeId}>
      <ProfileAvatar
        role="user"
        hasPortrait={display.hasPortrait}
        fallbackEmoji={display.fallbackEmoji}
        portraitUrl={display.portraitUrl}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 mb-0.5">
          <span className="text-base font-bold text-accent-orange uppercase tracking-wide">
            {display.displayName}
          </span>
          {display.displayId && (
            <span className="text-xs text-muted-foreground">
              {display.displayId}
            </span>
          )}
        </div>
        <div className="text-base leading-snug text-foreground whitespace-pre-wrap break-words">{msg.content}</div>
      </div>
    </div>
  );
});

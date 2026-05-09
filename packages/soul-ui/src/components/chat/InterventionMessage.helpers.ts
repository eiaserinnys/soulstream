/**
 * InterventionMessage 표시 분기 helper.
 *
 * 컴포넌트 본체에서 hooks(useDashboardStore 등) 호출만 분리하고, 분기 로직은 본 helper에서
 * 순수 함수로 결정한다 (design-principles §1 깊이 + §10 인터페이스가 테스트 표면).
 *
 * 분기 우선순위 (높→낮):
 *   1. system  — caller_info.source === "system" → 정적 자산 + 고정 이름
 *   2. agent   — agentInfo 있고 system 아님 → 노드 프록시 portrait + agent 이름
 *   3. user    — 그 외 → caller_info / 세션 metadata / dashboardConfig.user 다단 fallback
 *
 * F-11 (2026-05-09, atom F-11): system 분기 신설.
 */

import type { ChatMessage } from "../../lib/flatten-tree";
import type { ProfileConfig } from "../../stores/dashboard-store-types";
import { pickMessageAvatarUrl } from "./userAvatarSelectors";

export interface InterventionDisplay {
  isSystem: boolean;
  isAgent: boolean;
  displayName: string;
  displayId: string | null;
  portraitUrl: string | null;
  hasPortrait: boolean;
  fallbackEmoji: string;
}

const SYSTEM_PORTRAIT_URL = "/system-portrait.png";
const SYSTEM_DEFAULT_NAME = "Soulstream";
const FALLBACK_SYSTEM = "\u{2699}\u{FE0F}";
const FALLBACK_AGENT = "\u{1F916}";
const FALLBACK_USER = "\u{270B}"; // ✋ raised hand — intervention

/** 분기 결정 + 모든 표시 필드 도출. 순수 함수. */
export function computeInterventionDisplay(
  msg: ChatMessage,
  callerAvatarUrl: string | null | undefined,
  userConfig: ProfileConfig | null | undefined,
): InterventionDisplay {
  const isSystem = msg.callerInfo?.source === "system";
  const isAgent = !!msg.agentInfo && !isSystem;

  // ---- system 분기 ----
  if (isSystem) {
    const callerName = msg.callerInfo?.display_name;
    const displayName =
      typeof callerName === "string" && callerName.length > 0
        ? callerName
        : SYSTEM_DEFAULT_NAME;
    return {
      isSystem: true,
      isAgent: false,
      displayName,
      displayId: null,
      portraitUrl: SYSTEM_PORTRAIT_URL,
      hasPortrait: true,
      fallbackEmoji: FALLBACK_SYSTEM,
    };
  }

  // ---- agent 분기 ----
  if (isAgent) {
    const agentInfo = msg.agentInfo!;
    const agentName = agentInfo.agent_name ?? agentInfo.agent_id ?? "Agent";
    const displayId = `${agentName}@${agentInfo.agent_node}`;
    const portraitUrl = agentInfo.agent_id
      ? `/api/nodes/${agentInfo.agent_node}/agents/${agentInfo.agent_id}/portrait`
      : null;
    return {
      isSystem: false,
      isAgent: true,
      displayName: agentName,
      displayId,
      portraitUrl,
      hasPortrait: !!portraitUrl,
      fallbackEmoji: FALLBACK_AGENT,
    };
  }

  // ---- user 분기 (fallback 사슬) ----
  const callerName = msg.callerInfo?.display_name;
  const displayName =
    typeof callerName === "string" && callerName.length > 0
      ? callerName
      : userConfig && userConfig.name !== "USER"
        ? userConfig.name
        : "Intervention";
  const displayId = userConfig?.id ? userConfig.id : null;
  const portraitUrl = pickMessageAvatarUrl(
    msg.callerInfo,
    callerAvatarUrl ?? null,
    userConfig?.portraitUrl ?? null,
  );
  return {
    isSystem: false,
    isAgent: false,
    displayName,
    displayId,
    portraitUrl,
    hasPortrait: !!portraitUrl,
    fallbackEmoji: FALLBACK_USER,
  };
}

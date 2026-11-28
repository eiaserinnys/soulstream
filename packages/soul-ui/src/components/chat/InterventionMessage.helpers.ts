/**
 * InterventionMessage 표시 분기 helper.
 *
 * 컴포넌트 본체에서 hooks(useDashboardStore 등) 호출만 분리하고, 분기 로직은 본 helper에서
 * 순수 함수로 결정한다 (design-principles §1 깊이 + §10 인터페이스가 테스트 표면).
 *
 * 분기 우선순위 (높→낮):
 *   1. system  — caller_info.source === "system" → 정적 자산 + 고정 이름
 *   2. agent   — agentInfo 있고 system 아님 → 중앙 초상 주소 + agent 이름
 *   3. user    — 그 외 → caller_info / 세션 metadata
 *
 * F-11 (2026-05-09, atom F-11): system 분기 신설.
 */

import type { useTranslation } from "react-i18next";
import type { ChatMessage } from "../../lib/flatten-tree";
import { externalSenderDisplay, type ExternalSender } from "./externalSender";
import { pickMessageAvatarUrl } from "./userAvatarSelectors";

export interface InterventionDisplay {
  external?: ExternalSender;
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
  t: ReturnType<typeof useTranslation>["t"],
  msg: ChatMessage,
  callerAvatarUrl: string | null | undefined,
  /** 에이전트 id → 중앙 초상 주소(없으면 빈 문자열). 노드 id로 주소를 만들지 않는다. */
  resolvePortraitUrl: (agentId: string) => string = () => "",
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
    // R-3 (atom G-5, 2026-05-11): wire avatar_url 우선 + 정적 자산 fallback (graceful).
    // 새 system 메시지는 build_system_caller_info가 /api/system/portraits/system 박음.
    // F-11D~E 머지 이후 영속화된 기존 system 메시지(avatar_url=None)는 정적 자산 fallback —
    // backfill 별 hygiene 카드로 분리 후 SYSTEM_PORTRAIT_URL 정적 상수 정리.
    const callerAvatar = msg.callerInfo?.avatar_url;
    const portraitUrl =
      typeof callerAvatar === "string" && callerAvatar.length > 0
        ? callerAvatar
        : SYSTEM_PORTRAIT_URL;
    return {
      isSystem: true,
      isAgent: false,
      displayName,
      displayId: null,
      portraitUrl,
      hasPortrait: true,
      fallbackEmoji: FALLBACK_SYSTEM,
    };
  }

  const external = externalSenderDisplay(msg.callerInfo, t);
  if (external) {
    return { isSystem: false, isAgent: false, displayName: external.name, displayId: null,
      portraitUrl: null, hasPortrait: false, fallbackEmoji: "", external };
  }

  // ---- agent 분기 ----
  if (isAgent) {
    const agentInfo = msg.agentInfo!;
    const agentName = agentInfo.agent_name ?? agentInfo.agent_id ?? t("ui.chat.agent");
    const displayId = `${agentName}@${agentInfo.agent_node}`;
    const portraitUrl = (agentInfo.agent_id ? resolvePortraitUrl(agentInfo.agent_id) : "") || null;
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

  // ---- user 분기 ----
  const callerName = msg.callerInfo?.display_name;
  const displayName =
    typeof callerName === "string" && callerName.length > 0
      ? callerName
      : t("ui.chat.intervention");
  const portraitUrl = pickMessageAvatarUrl(
    msg.callerInfo,
    callerAvatarUrl ?? null,
  );
  return {
    isSystem: false,
    isAgent: false,
    displayName,
    displayId: null,
    portraitUrl,
    hasPortrait: !!portraitUrl,
    fallbackEmoji: FALLBACK_USER,
  };
}

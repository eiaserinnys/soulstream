/**
 * ProfileAvatar - 채팅창 프로필 이미지 컴포넌트
 *
 * portraitUrl이 있으면 해당 URL에서 이미지를 로드하여 32x32 둥근 사각형으로 표시.
 * portraitUrl이 없으면 이모지 fallback으로 표시.
 *
 * Fallback 트리거:
 *  - onError: HTTP 4xx/5xx, 네트워크 실패, 이미지 디코딩 실패.
 *  - onLoad + naturalWidth === 0: 204 No Content 같은 빈 응답 (orch-server가
 *    portrait 미존재 시 노이즈 감소를 위해 204를 반환). 일부 브라우저는 이런
 *    경우 onError 대신 onLoad를 발생시키므로 두 가드를 함께 둔다.
 */

import { useState } from "react";
import { Link, Webhook } from "lucide-react";
import { normalizeAgentPortraitUrl } from "../lib/agent-portrait";
import { useAgentPortraitDictionary } from "../stores/agent-portrait-store";

interface ProfileAvatarProps {
  role: "user" | "assistant";
  hasPortrait: boolean;
  fallbackEmoji: string;
  /** 에이전트별 portrait URL. 있으면 role 기반 URL 대신 사용. */
  portraitUrl?: string | null;
  external?: { icon: "link" | "webhook"; title: string };
  shape?: 'rounded' | 'circle';
}

export function ProfileAvatar({ role, hasPortrait, fallbackEmoji, portraitUrl, external, shape = 'rounded' }: ProfileAvatarProps) {
  const dictionary = useAgentPortraitDictionary();
  // 오류는 그 주소에만 붙는다. 주소가 바뀌면(초상을 새로 올렸거나 목록을 다시 받은 뒤) 다시 시도한다.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = dictionary === null ? (portraitUrl ?? '') : normalizeAgentPortraitUrl(portraitUrl, dictionary);
  const imgError = failedSrc === src;

  if (external) {
    const Icon = external.icon === "webhook" ? Webhook : Link;
    return <span role="img" aria-label={`외부 연동 ${external.title}`} title={external.title}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--lg-line)] bg-[var(--control-surface)] text-muted-foreground">
      <Icon size={16} aria-hidden="true" />
    </span>;
  }
  const showPortrait = !!src;
  if (!showPortrait || imgError) {
    return (
      <span className={`w-8 h-8 flex items-center justify-center text-sm shrink-0 ${shape === 'circle' ? 'rounded-full' : 'rounded-floor'}`}>
        {fallbackEmoji}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={role === "user" ? "사용자" : "어시스턴트"}
      className={`w-8 h-8 ${shape === 'circle' ? 'rounded-full' : 'rounded-floor'} shrink-0 object-cover`}
      onError={() => setFailedSrc(src)}
      onLoad={(e) => {
        // 204 No Content 또는 이미지 디코딩 실패 시 naturalWidth === 0
        // 일부 브라우저는 이런 경우 onError 대신 onLoad를 발생시키므로 같이 가드
        if (e.currentTarget.naturalWidth === 0) {
          setFailedSrc(src);
        }
      }}
    />
  );
}

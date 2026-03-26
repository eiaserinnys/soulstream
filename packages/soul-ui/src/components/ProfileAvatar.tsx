/**
 * ProfileAvatar - 채팅창 프로필 이미지 컴포넌트
 *
 * portraitUrl이 있으면 해당 URL에서 이미지를 로드.
 * 없으면 /api/dashboard/portrait/{role} 에서 이미지를 로드하여 32x32 둥근 사각형으로 표시.
 * 이미지가 없거나 로드 실패 시 이모지 fallback.
 */

import { useState } from "react";

interface ProfileAvatarProps {
  role: "user" | "assistant";
  hasPortrait: boolean;
  fallbackEmoji: string;
  /** 에이전트별 portrait URL. 있으면 role 기반 URL 대신 사용. */
  portraitUrl?: string | null;
}

export function ProfileAvatar({ role, hasPortrait, fallbackEmoji, portraitUrl }: ProfileAvatarProps) {
  const [imgError, setImgError] = useState(false);

  const showPortrait = portraitUrl ? true : hasPortrait;
  if (!showPortrait || imgError) {
    return (
      <span className="w-8 h-8 flex items-center justify-center text-sm shrink-0">
        {fallbackEmoji}
      </span>
    );
  }

  const src = portraitUrl ?? `/api/dashboard/portrait/${role}`;

  return (
    <img
      src={src}
      alt={role}
      className="w-8 h-8 rounded-lg shrink-0 object-cover"
      onError={() => setImgError(true)}
    />
  );
}

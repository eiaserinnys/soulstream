/**
 * ProfileAvatar - 채팅창 프로필 이미지 컴포넌트
 *
 * 서버의 /api/dashboard/portrait/{role} 에서 이미지를 로드하여 32x32 둥근 사각형으로 표시.
 * 이미지가 없거나 로드 실패 시 이모지 fallback.
 */

import { useState } from "react";

interface ProfileAvatarProps {
  role: "user" | "assistant";
  hasPortrait: boolean;
  fallbackEmoji: string;
}

export function ProfileAvatar({ role, hasPortrait, fallbackEmoji }: ProfileAvatarProps) {
  const [imgError, setImgError] = useState(false);

  if (!hasPortrait || imgError) {
    return (
      <span className="w-8 h-8 flex items-center justify-center text-sm shrink-0">
        {fallbackEmoji}
      </span>
    );
  }

  return (
    <img
      src={`/api/dashboard/portrait/${role}`}
      alt={role}
      className="w-8 h-8 rounded-lg shrink-0 object-cover"
      onError={() => setImgError(true)}
    />
  );
}

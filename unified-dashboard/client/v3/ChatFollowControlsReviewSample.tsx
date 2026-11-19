import { useState } from "react";
import { ChatFollowControls } from "@seosoyoung/soul-ui/components/chat/ChatView.follow-controls";

function FollowControlsExample({ label, initialFollowing = false, initialMessage = false, narrow = false }: {
  label: string;
  initialFollowing?: boolean;
  initialMessage?: boolean;
  narrow?: boolean;
}) {
  const [following, setFollowing] = useState(initialFollowing);
  const [hasNewMessage, setHasNewMessage] = useState(initialMessage);
  function updateFollow(next: boolean) {
    setFollowing(next);
    if (next) setHasNewMessage(false);
  }

  return (
    <div className={narrow ? "w-full max-w-xs" : "w-full max-w-md"}>
      <p className="v3-components-label">{label}</p>
      <ChatFollowControls
        isFollowing={following}
        showNewMessage={hasNewMessage}
        onToggleFollow={() => updateFollow(!following)}
        onJumpToLatest={() => updateFollow(true)}
      />
    </div>
  );
}

export function ChatFollowControlsReviewSample() {
  return (
    <div className="grid gap-2">
      <FollowControlsExample label="자동 스크롤 켜짐" initialFollowing />
      <FollowControlsExample label="자동 스크롤 꺼짐" />
      <FollowControlsExample label="새 메시지 배너 표시" initialMessage />
      <FollowControlsExample label="좁은 대화 칸" initialMessage narrow />
    </div>
  );
}

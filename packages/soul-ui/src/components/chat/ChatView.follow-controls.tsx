import { useRef } from "react";
import { cn } from "../../lib/cn";

const controlClass = "flex select-none items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-xs font-medium glass-shadow-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const accentClass = "border-accent-blue/30 bg-accent-blue/15 text-accent-blue hover:bg-accent-blue/25";

interface ChatFollowControlsProps {
  isFollowing: boolean;
  showNewMessage: boolean;
  onToggleFollow: () => void;
  onJumpToLatest: () => void;
}

export function ChatFollowControls({ isFollowing, showNewMessage, onToggleFollow, onJumpToLatest }: ChatFollowControlsProps) {
  const followToggleRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(min-content,1fr)] items-center gap-2 pb-2">
      {showNewMessage && !isFollowing && (
        <button
          type="button"
          onClick={() => {
            followToggleRef.current?.focus({ preventScroll: true });
            onJumpToLatest();
          }}
          className={cn("col-start-2", controlClass, accentClass)}
        >
          {"\u2193"} 새 메시지
        </button>
      )}
      <button
        ref={followToggleRef}
        type="button"
        onClick={onToggleFollow}
        aria-pressed={isFollowing}
        className={cn(
          "col-start-3 justify-self-end",
          controlClass,
          isFollowing
            ? cn(accentClass, "underline underline-offset-2")
            : "border-glass-border glass text-muted-foreground hover:text-foreground",
        )}
      >
        {"\u2193"} 자동 스크롤
      </button>
    </div>
  );
}

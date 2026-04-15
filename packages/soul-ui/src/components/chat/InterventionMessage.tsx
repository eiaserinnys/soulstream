import { memo } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { useDashboardStore } from "../../stores/dashboard-store";
import { ProfileAvatar } from "../ProfileAvatar";

export const InterventionMessage = memo(function InterventionMessage({ msg }: { msg: ChatMessage }) {
  const config = useDashboardStore((s) => s.dashboardConfig);
  const userConfig = config?.user;
  const displayName = userConfig && userConfig.name !== "USER"
    ? `${userConfig.name}`
    : "Intervention";
  const displayId = userConfig?.id ? `${userConfig.id}` : null;

  return (
    <div className="flex gap-2 px-3 py-1" data-tree-node-id={msg.treeNodeId}>
      <ProfileAvatar
        role="user"
        hasPortrait={userConfig?.hasPortrait ?? false}
        fallbackEmoji={"\u270B"}
        portraitUrl={userConfig?.portraitUrl ?? null}
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

/**
 * NodeGuardBadge - 다른 노드 세션 표시 배지 (unified-dashboard)
 *
 * single-node 모드(features.nodeGuard = true)에서만 사용.
 * 활성 세션이 현재 접속한 soul-server와 다른 노드 소속임을 표시한다.
 * 이 배지가 표시될 때 ChatInput도 비활성화된다(chatInputDisabled).
 */

import { cn } from "@seosoyoung/soul-ui";

interface NodeGuardBadgeProps {
  nodeId: string | null | undefined;
  className?: string;
}

export function NodeGuardBadge({ nodeId, className }: NodeGuardBadgeProps) {
  if (!nodeId) return null;

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium",
        "bg-accent-amber/15 text-accent-amber border border-accent-amber/30",
        className,
      )}
      title={`이 세션은 다른 노드(${nodeId})에서 실행 중입니다`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-accent-amber" />
      다른 노드: {nodeId}
    </div>
  );
}

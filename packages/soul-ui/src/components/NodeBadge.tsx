/**
 * NodeBadge - 노드 ID 뱃지
 *
 * 노드 ID를 hue 해시 기반 색상으로 표시한다.
 * FeedCard, SessionItem 등 다수의 컴포넌트에서 중복 계산되던 로직을 통합.
 */

import { useTheme } from "../hooks/useTheme";
import { nodeIdToHue } from "../lib/nodeColors";
import { Badge } from "./ui/badge";
import { cn } from "../lib/cn";

export interface NodeBadgeProps {
  nodeId: string;
  className?: string;
}

export function NodeBadge({ nodeId, className }: NodeBadgeProps) {
  const [theme] = useTheme();
  const hue = nodeIdToHue(nodeId);
  const isDark = theme === "dark";
  const bg = isDark ? `hsl(${hue}, 12%, 28%)` : `hsl(${hue}, 20%, 88%)`;
  const color = isDark ? `hsl(${hue}, 18%, 72%)` : `hsl(${hue}, 30%, 35%)`;
  return (
    <Badge
      variant="secondary"
      className={cn("text-xs px-1 py-0", className)}
      style={{ backgroundColor: bg, color }}
    >
      {nodeId}
    </Badge>
  );
}

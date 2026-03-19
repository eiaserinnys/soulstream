/**
 * SessionCard — 세션 카드. 세션 ID, 상태 표시.
 */

import type { OrchestratorSession } from "../store/types";

function statusDotClass(status: OrchestratorSession["status"]): string {
  switch (status) {
    case "running":
      return "bg-success animate-pulse";
    case "idle":
      return "bg-accent-amber";
    case "completed":
      return "bg-muted-foreground/30";
    case "error":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/30";
  }
}

function statusColor(status: OrchestratorSession["status"]): string {
  switch (status) {
    case "running":
      return "text-success";
    case "idle":
      return "text-accent-amber";
    case "completed":
      return "text-muted-foreground/50";
    case "error":
      return "text-destructive";
    default:
      return "text-muted-foreground/50";
  }
}

interface SessionCardProps {
  session: OrchestratorSession;
  isSelected: boolean;
  isActive: boolean;
  onClick: () => void;
}

export function SessionCard({
  session,
  isSelected,
  isActive,
  onClick,
}: SessionCardProps) {
  // 세션 ID 축약 표시
  const shortId =
    session.sessionId.length > 20
      ? session.sessionId.slice(0, 8) + "..." + session.sessionId.slice(-4)
      : session.sessionId;

  return (
    <div
      className={`bg-card border rounded-[10px] px-3 py-2.5 cursor-pointer transition-colors shrink-0 border-l-[3px] ${
        isSelected
          ? "border-l-accent-blue bg-accent-blue/[0.06] border-accent-blue/15"
          : isActive
            ? "border-l-success border-border"
            : "border-l-transparent border-border"
      } hover:bg-muted`}
      onClick={onClick}
    >
      {/* Top: session ID + status */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-mono font-medium text-foreground tracking-wide">
          {shortId}
        </span>
        <div className="flex items-center gap-1">
          <div
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDotClass(session.status)}`}
          />
          <span
            className={`text-[10px] font-mono uppercase tracking-wider ${statusColor(session.status)}`}
          >
            {session.status}
          </span>
        </div>
      </div>

      {/* Node ID */}
      <div className="text-[11px] text-muted-foreground/50 font-mono">
        {session.nodeId}
      </div>
    </div>
  );
}

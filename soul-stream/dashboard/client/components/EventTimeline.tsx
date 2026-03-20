/**
 * EventTimeline — SSE 이벤트 타임라인 (Phase 1: 단순 목록).
 * Phase 2에서 히스토리 replay 기능으로 개선 예정.
 */

import { useEffect, useRef } from "react";
import { cn } from "@seosoyoung/soul-ui";
import type { SessionEvent } from "../hooks/useSessionEvents";

interface EventItemConfig {
  dotClass: string;
  labelClass: string;
  label: string;
}

function getEventConfig(type: string): EventItemConfig {
  switch (type) {
    case "progress":
      return { dotClass: "bg-accent-blue", labelClass: "text-accent-blue", label: "progress" };
    case "tool_start":
      return { dotClass: "bg-accent-amber", labelClass: "text-accent-amber", label: "tool" };
    case "tool_result":
      return { dotClass: "bg-success", labelClass: "text-success", label: "result" };
    case "init":
      return { dotClass: "bg-muted-foreground", labelClass: "text-muted-foreground", label: "init" };
    default:
      return { dotClass: "bg-muted-foreground/50", labelClass: "text-muted-foreground/50", label: type };
  }
}

function getEventSummary(event: SessionEvent): string {
  // event.event 필드에서 요약 텍스트 추출 시도
  const inner = event.event;
  if (inner && typeof inner === "object") {
    const text =
      (inner as Record<string, unknown>).text ??
      (inner as Record<string, unknown>).content ??
      (inner as Record<string, unknown>).message ??
      (inner as Record<string, unknown>).tool_name;
    if (typeof text === "string" && text.trim()) {
      return text.length > 80 ? text.slice(0, 77) + "..." : text;
    }
  }
  return JSON.stringify(event).slice(0, 80);
}

interface EventTimelineProps {
  events: SessionEvent[];
}

export function EventTimeline({ events }: EventTimelineProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // 새 이벤트가 올 때마다 하단으로 스크롤
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  if (events.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-xs text-muted-foreground/30 font-mono text-center">
          이벤트 스트림 대기 중...
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-3.5 py-3 flex flex-col gap-1.5">
      {events.map((ev, i) => {
        const config = getEventConfig(ev.type);
        const summary = getEventSummary(ev);
        return (
          <div key={i} className="flex items-start gap-2 group">
            <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
              <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", config.dotClass)} />
              <span className={cn("text-[10px] font-mono w-[64px] shrink-0", config.labelClass)}>
                {config.label}
              </span>
            </div>
            <span className="text-[12px] text-foreground/70 leading-snug break-all">
              {summary}
            </span>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

/**
 * EventTimeline — SSE 이벤트 타임라인.
 * Phase 2: 히스토리 replay 스크롤 처리 개선.
 *
 * 스크롤 전략:
 *   - init 이벤트 수신 후 캐시 replay burst 동안 스크롤 고정 OFF
 *   - 300ms 동안 새 이벤트가 없으면 replay 완료로 판정 → 하단 스크롤 후 live 모드 ON
 *   - live 모드에서는 이벤트 수신마다 하단 스크롤
 */

import { useEffect, useRef } from "react";
import { cn } from "@seosoyoung/soul-ui";
import type { SessionEvent } from "../hooks/useSessionEvents";

const REPLAY_SETTLE_MS = 300;

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
  // replay 완료 여부 (true = live 모드, 이벤트마다 스크롤)
  const isLiveRef = useRef(false);
  // replay settle 타이머 핸들
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (events.length === 0) {
      // 세션 리셋 — live 모드 초기화
      isLiveRef.current = false;
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      return;
    }

    const lastEvent = events[events.length - 1];

    if (lastEvent.type === "init") {
      // 새 SSE 연결 시작 — replay 모드로 전환
      isLiveRef.current = false;
    }

    if (!isLiveRef.current) {
      // replay 모드: burst settle 타이머 리셋
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(() => {
        // burst 종료 — 하단으로 한 번에 스크롤 후 live 모드 전환
        isLiveRef.current = true;
        settleTimerRef.current = null;
        bottomRef.current?.scrollIntoView({ behavior: "instant" });
      }, REPLAY_SETTLE_MS);
    } else {
      // live 모드: 이벤트마다 하단 스크롤
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [events]);

  // 컴포넌트 언마운트 시 타이머 정리
  useEffect(() => {
    return () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    };
  }, []);

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

import { useEffect, useRef } from "react";
import { ClaudeRuntimeSchedulesPanel } from "@seosoyoung/soul-ui/components/ClaudeRuntimeSchedulesPanel";

const reviewSchedule = {
  scheduleId: "review-schedule-1",
  kind: "cron" as const,
  status: "active" as const,
  nextRunAt: "2026-11-19T00:00:00.000Z",
};

const runtimeWithSchedule = {
  updatedAt: 0,
  tasks: {},
  notifications: {},
  remoteTriggers: {},
  schedules: { "review-schedule-1": reviewSchedule },
};

/**
 * 런타임 띠의 세 가지 순간: 첫 로딩에는 아무것도 그리지 않고, 응답 뒤 보일 항목이
 * 있을 때만 접힌 머리줄이 나타나며, 데이터가 있는 새로고침에서는 머리 단추만 돈다.
 * 요청은 바깥(검수 스크립트)에서 붙잡아 둔다.
 */
export function RuntimeLoadingReviewSample() {
  const refreshHostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 데이터가 있는 새로고침을 보이도록 한 번 누른다. 응답은 검수 스크립트가 붙잡는다.
    refreshHostRef.current
      ?.querySelector<HTMLButtonElement>('button[title="새로고침"]')
      ?.click();
  }, []);

  return <div className="v3-detail-pane v3-detail-pane--inline" data-testid="runtime-loading-review">
    <p className="v3-components-label">
      ClaudeRuntimeSchedulesPanel · 첫 로딩(빈 띠) · 응답 뒤 접힌 머리줄 · 데이터 있는 새로고침(단추만 회전)
    </p>
    <div className="grid w-full max-w-[calc(var(--v3-space-8)*16)] gap-3">
      <div data-testid="runtime-sample-first-loading" className="flex min-h-12 flex-col rounded border border-dashed border-border/60 p-2">
        <span className="v3-components-label">첫 로딩 — 띠를 그리지 않는다</span>
        <ClaudeRuntimeSchedulesPanel sessionId="review-runtime-loading" runtime={null} tone="calm" variant="caption" />
      </div>
      <div className="rounded border border-border/60 p-2">
        <span className="v3-components-label">응답 뒤 — 보일 항목이 있을 때만 접힌 머리줄</span>
        <ClaudeRuntimeSchedulesPanel sessionId="review-runtime-loaded" runtime={runtimeWithSchedule} tone="calm" variant="caption" />
      </div>
      <div ref={refreshHostRef} data-testid="runtime-sample-refresh" className="rounded border border-border/60 p-2">
        <span className="v3-components-label">데이터 있는 새로고침 — 머리 단추만 회전</span>
        <ClaudeRuntimeSchedulesPanel sessionId="review-runtime-refresh" runtime={runtimeWithSchedule} tone="calm" variant="caption" />
      </div>
    </div>
  </div>;
}

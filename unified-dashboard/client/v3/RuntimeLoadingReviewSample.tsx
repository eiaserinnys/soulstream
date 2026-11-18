import { ClaudeRuntimeSchedulesPanel } from "@seosoyoung/soul-ui/components/ClaudeRuntimeSchedulesPanel";

/** 런타임 일정 패널의 첫 로딩 — 요청을 붙잡아 둔 채 본문 가운데에서 기다리는 모습을 잰다. */
export function RuntimeLoadingReviewSample() {
  return <div className="v3-detail-pane v3-detail-pane--inline" data-testid="runtime-loading-review">
    <p className="v3-components-label">ClaudeRuntimeSchedulesPanel · 첫 로딩 · 실제 요청</p>
    <div style={{ width: "calc(var(--v3-space-8) * 16)" }}>
      <ClaudeRuntimeSchedulesPanel sessionId="review-runtime-loading" runtime={null} tone="calm" variant="caption" />
    </div>
  </div>;
}

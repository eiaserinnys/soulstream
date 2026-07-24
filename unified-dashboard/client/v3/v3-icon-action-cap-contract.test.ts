import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("v3 icon action cap contract", () => {
  it("uses one component for the v1 reference buttons and v3 actions", () => {
    const component = read("../../../packages/soul-ui/src/components/DashboardIconCap.tsx");
    const theme = read("../../../packages/soul-ui/src/components/ThemeToggle.tsx");
    const config = read("../components/ConfigButton.tsx");
    const css = read("../../../packages/soul-ui/src/styles/globals.css");

    expect(component).toContain("dashboard-icon-cap border border-glass-border glass-strong glass-chrome lg-rim");
    expect(component).toContain('aria-label={label}');
    expect(component).toContain('title={tooltip ?? label}');
    expect(theme).toContain("<DashboardIconCap");
    expect(config).toContain("<DashboardIconCap");
    expect(css).toMatch(/\.dashboard-icon-cap \{[\s\S]*width: 44px;[\s\S]*height: 44px;[\s\S]*border-radius: 22px;/);
  });

  it.each([
    ["../../../packages/soul-ui/src/task/TaskCard.tsx", ["업무 보드 열기"]],
    ["../../../packages/soul-ui/src/task/TaskCompletionAction.tsx", ["actionLabel"]],
    ["./V3GlobalToolbar.tsx", ["기존 대시보드 열기"]],
    ["./PlannerTaskCard.tsx", ["별표"]],
    ["./TaskDetailPane.tsx", ["오늘 플래너로 돌아가기", "별표", "업무 보드 열기"]],
    ["./TaskTodayToggle.tsx", ["todayPlannerMenuLabel"]],
    ["./TaskDescriptionPanel.tsx", ["편집"]],
    ["./TaskInlineBoard.tsx", ["마크다운 추가", "펼치기", "이름 수정"]],
    ["./TaskRunHistory.tsx", ["새 세션", "이전 세션 더 보기"]],
    ["./TaskBoardPane.tsx", ["업무 상세로 돌아가기", "업무 보드 닫기"]],
    ["./TaskWorkspace.tsx", ["업무 창 닫기", "채팅 닫기"]],
    ["./TaskBoardWorkspace.tsx", ["문서 편집기 높이 축소"]],
    ["./PlannerViews.tsx", ["아침 정리", "새 업무", "오늘로 돌아가기", "새 문서", "이전 문서 더 보기", "이전 업무 더 보기"]],
    ["./V3Navigation.tsx", ["별표 업무 더 보기", "새 프로젝트"]],
    ["./V3SessionPanel.tsx", ["확인 처리"]],
    ["./V3SessionReviewBanner.tsx", ["검수 확인"]],
    ["./V3StandaloneDocumentInspector.tsx", ["문서 패널 닫기"]],
  ] as const)("%s uses the shared icon cap for its chrome actions", (path, labels) => {
    const source = read(path);
    expect(source).toContain("DashboardIconCap");
    for (const label of labels) expect(source).toContain(label);
  });

  it("keeps planner header actions compact without inflating title rows", () => {
    const css = read("./v3-planner.css");
    expect(css).toMatch(/\.v3-planner-head-action\.dashboard-icon-cap\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;/s);
  });

  it("keeps star and today controls as pressed-state toggles", () => {
    expect(read("./PlannerTaskCard.tsx")).toMatch(/DashboardIconCap[\s\S]*aria-pressed=\{taskStar\.starred\}/);
    expect(read("./TaskTodayToggle.tsx")).toMatch(/DashboardIconCap[\s\S]*aria-pressed=\{inToday\}/);
  });

  it("leaves the planner return action as the only visible close affordance in task detail", () => {
    const detail = read("./TaskDetailPane.tsx");
    const workspace = read("./TaskWorkspace.tsx");
    const layout = read("./V3DashboardLayout.tsx");

    expect(detail).toContain('label="오늘 플래너로 돌아가기"');
    expect(detail).not.toContain('label="업무 상세 닫기"');
    expect(workspace).not.toContain('label="우측 패널 닫기"');
    expect(workspace).toContain("onMouseDown={(event) => { if (event.target === event.currentTarget) onCloseWorkspace(); }}");
    expect(layout).toContain('if (event.key !== "Escape") return;');
    expect(layout).toContain("reduceMobilePlannerEscape");
  });
});

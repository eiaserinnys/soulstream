import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("v3 icon action cap contract", () => {
  it("uses one component for dashboard chrome actions", () => {
    const component = read("../../../packages/soul-ui/src/components/DashboardIconCap.tsx");
    const theme = read("../../../packages/soul-ui/src/components/ThemeToggle.tsx");
    const config = read("../components/ConfigButton.tsx");
    const css = read("../../../packages/soul-ui/src/styles/globals.css");

    expect(component).toContain('appearance = "default"');
    expect(component).toContain('"dashboard-icon-cap"');
    expect(component).toContain('"dashboard-icon-cap--bare"');
    expect(component).toContain('"border border-glass-border glass-strong glass-chrome lg-rim"');
    expect(component).toContain('aria-label={label}');
    expect(component).toContain('title={tooltip ?? label}');
    expect(theme).toContain("<DashboardIconCap");
    expect(config).toContain("<DashboardIconCap");
    expect(css).toMatch(/\.dashboard-icon-cap \{[\s\S]*width: 44px;[\s\S]*height: 44px;[\s\S]*border-radius: 22px;/);
    expect(css).toMatch(/\.dashboard-icon-cap--bare\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s);
  });

  it("uses bare lucide icons for PAS header actions and preserves the default glyphs", () => {
    const toolbar = read("./V3GlobalToolbar.tsx");
    const theme = read("../../../packages/soul-ui/src/components/ThemeToggle.tsx");
    const config = read("../components/ConfigButton.tsx");
    const minimal = toolbar.match(/if \(variant === 'minimal'\)[\s\S]*?<div className="dashboard-toolbar-actions">([\s\S]*?)<\/div>/)?.[1] ?? "";
    expect(minimal).toContain('<DashboardIconCap label="홈" appearance={appearance}');
    expect(minimal).toContain('<House className="size-5" strokeWidth={1.4} absoluteStrokeWidth');
    expect(theme).toContain('<Moon className="size-5" strokeWidth={1.4} absoluteStrokeWidth');
    expect(theme).toContain('<Sun className="size-5" strokeWidth={1.4} absoluteStrokeWidth');
    expect(minimal).toContain('<ConfigButton variant="chrome" appearance={appearance}');
    expect(config).toContain('<SlidersHorizontal className="size-5" strokeWidth={1.4} absoluteStrokeWidth');
    expect(toolbar).toContain('<span aria-hidden="true" className="text-base leading-none">⌂</span>');
    expect(theme).toContain('<span aria-hidden="true" className="text-base leading-none">◐</span>');
    expect(config).toContain('<span aria-hidden="true" className="text-base leading-none">⚙</span>');
    expect(minimal.indexOf('<ThemeToggle variant="chrome" appearance={appearance}/>'))
      .toBeLessThan(minimal.indexOf('<ConfigButton variant="chrome" appearance={appearance}'));
  });

  it.each([
    ["./FolderCardSection.tsx", ["카드 추가"]],
    ["../../../packages/soul-ui/src/folder-status/FolderCompletionAction.tsx", ["actionLabel"]],
    ["./PlannerFolderCard.tsx", ["별표"]],
    ["./FolderDetailPane.tsx", ["오늘 플래너로 돌아가기", "별표", "폴더 보드 열기"]],
    ["./FolderTodayToggle.tsx", ["todayPlannerMenuLabel"]],
    ["./FolderDescriptionPanel.tsx", ["편집"]],
    ["./FolderInlineBoard.tsx", ["마크다운 추가", "펼치기", "이름 수정"]],
    ["./FolderSessionHistory.tsx", ["새 세션", "이전 세션 더 보기"]],
    ["./FolderBoardPane.tsx", ["폴더 상세로 돌아가기", "폴더 보드 닫기"]],
    ["./FolderWorkspace.tsx", ["폴더 창 닫기", "채팅 닫기"]],
    ["./FolderBoardWorkspace.tsx", ["문서 편집기 높이 축소"]],
    ["./PlannerViews.tsx", ["아침 정리"]],
    ["./FolderWorkspaceSections.tsx", ["하위 폴더 더 보기"]],
    ["./V3Navigation.tsx", ["별표 폴더 더 보기", "새 폴더"]],
    ["./V3SessionPanel.tsx", ["확인 처리"]],
    ["./V3SessionReviewBanner.tsx", ["검수 확인"]],
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
    expect(read("./PlannerFolderCard.tsx")).toMatch(/DashboardIconCap[\s\S]*aria-pressed=\{folderStar\.starred\}/);
    expect(read("./FolderTodayToggle.tsx")).toMatch(/DashboardIconCap[\s\S]*aria-pressed=\{inToday\}/);
  });

  it("leaves the planner return action as the only visible close affordance in task detail", () => {
    const detail = read("./FolderDetailPane.tsx");
    const workspace = read("./FolderWorkspace.tsx");
    const layout = read("./V3DashboardLayout.tsx");

    expect(detail).toContain('parentFolder ? "상위 폴더로 이동" : "오늘 플래너로 돌아가기"');
    expect(detail).not.toContain('label="폴더 상세 닫기"');
    expect(workspace).not.toContain('label="우측 패널 닫기"');
    expect(workspace).toContain("onMouseDown={(event) => { if (event.target === event.currentTarget) onCloseWorkspace(); }}");
    expect(layout).toContain('if (event.key !== "Escape") return;');
    expect(layout).toContain("reduceMobilePlannerEscape");
  });
});

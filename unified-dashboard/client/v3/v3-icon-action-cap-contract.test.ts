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
    expect(css).toMatch(/\.dashboard-icon-cap \{[\s\S]*width: 44px;[\s\S]*height: 44px;[\s\S]*border-radius: var\(--radius-pill\);/);
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
    ["./FolderCardSection.tsx", ["folders.cards.add"]],
    ["../../../packages/soul-ui/src/folder-status/FolderCompletionAction.tsx", ["actionLabel"]],
    ["./FolderDetailPane.tsx", ["folders.workspace.backToCards", "folders.common.addStar", "folders.common.removeStar"]],
    ["./FolderDescriptionPanel.tsx", ["folders.description.edit"]],
    ["./FolderInlineBoard.tsx", ["folders.board.addMarkdown", "folders.board.saveRename", "folders.board.cancelRename"]],
    ["./FolderSessionHistory.tsx", ["folders.session.new"]],
    ["./FolderWorkspace.tsx", ["folders.workspace.close"]],
    ["./FolderWorkspaceSections.tsx", ["folders.workspace.moreSubfolders"]],
    ["./V3Navigation.tsx", ["별표 폴더 더 보기", "새 폴더"]],
    ["./V3SessionReviewBanner.tsx", ["검수 확인"]],
  ] as const)("%s uses the shared icon cap for its chrome actions", (path, labels) => {
    const source = read(path);
    expect(source).toContain("DashboardIconCap");
    for (const label of labels) expect(source).toContain(label);
  });

  it("keeps inline markdown expand and rename actions at their shared owner", () => {
    const board = read("./FolderInlineBoard.tsx");
    const inlineCard = read("./InlineMarkdownCard.tsx");

    expect(board).toMatch(/<InlineMarkdownCard key=\{item\.id\} title=\{title\} expanded=\{expanded\}[\s\S]*?onToggle=\{\(\) => setExpandedId\(expanded \? null : item\.id\)\}[\s\S]*?onRename=\{\(\) => beginRename\(item\)\}/);
    expect(inlineCard).toContain("DashboardIconCap");
    expect(inlineCard).toContain('label={t("cards.toggleDocument", {title,action:expanded?t("cards.collapse"):t("cards.expand")})}');
    expect(inlineCard).toContain('label={t("cards.renameDocument", {title})}');
    expect(inlineCard).toContain("aria-expanded={expanded} onClick={onToggle}");
    expect(inlineCard).toContain("onClick={onRename}");
  });

  it("replaces manual run-history pagination with the shared auto-loader retry", () => {
    const history = read("./FolderSessionHistory.tsx");
    const loader = read("./RunHistoryAutoLoader.tsx");

    expect(history).toMatch(/<RunHistoryAutoLoader hasMore=\{runHistoryHasMore\} loading=\{runHistoryLoading\}[\s\S]*?failed=\{runHistoryFailed\} onLoadMore=\{onLoadMoreRuns\}/);
    expect(loader).toContain('<DashboardIconCap label="다시 시도" onClick={() => { void onLoadMore(); }}>');
  });

  it("keeps chat close on the shared session header only when its owner passes onClose", () => {
    const workspace = read("./FolderWorkspace.tsx");
    const headers = read("./WorkspacePanelHeaders.tsx");

    expect(workspace).toMatch(/<SessionPanelHeader session=\{activeSession\}[\s\S]*?onClose=\{onCloseWorkspace\}\/>/);
    expect(workspace.match(/<SessionPanelHeader\b/g)).toHaveLength(2);
    expect(workspace.match(/<SessionPanelHeader\b[^>]*onClose=/g)).toHaveLength(1);
    expect(headers).toContain('{onClose ? <DashboardIconCap label="채팅 닫기" onClick={onClose}');
  });

  it("forwards review acknowledgement through the shared row action owner", () => {
    const panel = read("./V3SessionPanel.tsx");
    const richRow = read("./RichSessionRow.tsx");
    const rowFrame = read("./RunRowFrame.tsx");
    const reviewRow = panel.match(/<RichSessionRow\b[\s\S]*?\/>/)?.[0] ?? "";

    expect(reviewRow).toContain('actions={review ? [{kind:"acknowledge",label:`${sessionPanelTitle(session)} 확인 처리`,pending,onAction:()=>{void onAcknowledge(session);}}] : undefined}');
    expect(richRow).toMatch(/<RunRowFrame[\s\S]*?actions=\{actions\}/);
    expect(rowFrame).toMatch(/actions!\.map\(action=><DashboardIconCap[\s\S]*?label=\{action\.label\}[\s\S]*?disabled=\{disabled\|\|action\.disabled\|\|action\.pending\}[\s\S]*?onClick=\{event=>\{event\.stopPropagation\(\);action\.onAction\(event\);\}\}/);
  });

  it("keeps planner header actions compact without inflating title rows", () => {
    const css = read("./v3-planner.css");
    expect(css).toMatch(/\.v3-planner-head-action\.dashboard-icon-cap\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;/s);
  });

  it("keeps star and today controls as pressed-state toggles", () => {
    const folderCard = read("./PlannerFolderCard.tsx");
    const rowFrame = read("./RunRowFrame.tsx");

    expect(folderCard).toMatch(/<RunRowFrame[\s\S]*?actions=\{\[/);
    expect(folderCard).toContain('kind:"star"');
    expect(folderCard).toContain("pressed:folderStar.starred,pending:folderStar.pending,onAction:()=>{void folderStar.toggle();}");
    expect(rowFrame).toMatch(/actions!\.map\(action=><DashboardIconCap[\s\S]*?label=\{action\.label\}[\s\S]*?disabled=\{disabled\|\|action\.disabled\|\|action\.pending\}[\s\S]*?aria-pressed=\{action\.kind==="star"\?action\.pressed:undefined\}[\s\S]*?action\.onAction\(event\)/);
  });

  it("leaves the planner return action as the only visible close affordance in task detail", () => {
    const detail = read("./FolderDetailPane.tsx");
    const workspace = read("./FolderWorkspace.tsx");
    const layout = read("./V3DashboardLayout.tsx");

    expect(detail).toContain('parentFolder ? t("folders.workspace.goParent") : t("folders.workspace.backToCards")');
    expect(detail).not.toContain('label="폴더 상세 닫기"');
    expect(workspace).not.toContain('label="우측 패널 닫기"');
    expect(workspace).toContain("onMouseDown={(event) => { if (event.target === event.currentTarget) onCloseWorkspace(); }}");
    expect(layout).toContain('if (event.key !== "Escape") return;');
    expect(layout).toContain("reduceMobilePlannerEscape");
  });
});

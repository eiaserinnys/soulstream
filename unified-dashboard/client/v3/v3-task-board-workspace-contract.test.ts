import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("task board r3 workspace contract", () => {
  it("composes the three workspace areas from existing product components", () => {
    const workspace = read("./TaskBoardWorkspace.tsx");
    const resources = read("./TaskBoardResourcePane.tsx");

    expect(workspace).toContain('data-testid="v3-task-board-resources"');
    expect(workspace).toContain('data-testid="v3-task-board-canvas"');
    expect(workspace).toContain('data-testid="v3-task-board-chat"');
    expect(workspace).toContain('data-testid="v3-task-board-document-overlay"');
    expect(workspace).toContain("<MarkdownDocumentPanel />");
    expect(workspace).toContain("<ChatView");
    expect(resources).toContain("<TaskCard");
    expect(resources).toContain("<RichSessionRow");
    expect(resources).toContain("<MarkdownContent");
    expect(resources).toContain("<CustomViewPanel");
    expect(resources).toContain('role="tablist"');
    expect(resources).toContain('aria-selected={tab.id === activeTabId}');
  });

  it("routes central resources into controlled left tabs while chat stays independent", () => {
    const workspace = read("./TaskBoardWorkspace.tsx");
    const board = read("./TaskBoardPane.tsx");
    const resources = read("./TaskBoardResourcePane.tsx");

    expect(workspace).toContain("openTaskBoardResource");
    expect(workspace).toContain("onOpenMarkdownDocument=");
    expect(workspace).toContain("onOpenCustomView=");
    expect(board).toContain("onOpenMarkdownDocument={onOpenMarkdownDocument}");
    expect(board).toContain("onOpenCustomView={onOpenCustomView}");
    expect(resources).toContain("onActiveTabChange(tab.id)");
    expect(resources).toContain("onOpenDocument(activeTab.documentId)");
    expect(workspace).toContain("<ChatView");
    expect(workspace).not.toContain("<RightPanel");
  });

  it("keeps the paper overlay out of the chat column at wide and narrow desktop widths", () => {
    const css = read("./v3-task-board.css");

    expect(css).toMatch(/\.v3-workspace\.v3-task-board-workspace\s*{[^}]*grid-template-columns:/s);
    expect(css).toMatch(/\.v3-task-board-document-overlay\s*{[^}]*grid-column:\s*3;/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*1180px\)[\s\S]*\.v3-task-board-document-overlay\s*{[^}]*grid-column:\s*1\s*\/\s*4;/s);
    expect(css).toMatch(/\.v3-task-board-chat\s*{[^}]*grid-column:\s*5;/s);
  });

  it("does not introduce a task-board design token or dependency surface", () => {
    const css = read("./v3-task-board.css");
    const workspace = read("./TaskBoardWorkspace.tsx");
    const resources = read("./TaskBoardResourcePane.tsx");

    expect(css).not.toMatch(/--v3-task-board-[\w-]+\s*:/);
    expect(`${workspace}\n${resources}`).not.toContain("style={{");
    expect(`${workspace}\n${resources}`).not.toContain("<svg");
  });
});

describe("task board panel resize, overlay height, and session list contract", () => {
  it("adds independent left and right resize handles reusing the existing DragHandle", () => {
    const workspace = read("./TaskBoardWorkspace.tsx");

    expect(workspace).toContain("DragHandle");
    expect(workspace).toContain('data-testid="v3-task-board-resize-handle"');
    expect(workspace).toContain('data-testid="v3-task-board-chat-resize-handle"');
    expect(workspace).toContain("clampTaskResourceWidth");
    expect(workspace).toContain("clampTaskChatWidth");
    // widths are reflected onto the existing layout tokens via setProperty, not inline style.
    expect(workspace).toContain('setProperty("--v3-navigation-width"');
    expect(workspace).toContain('setProperty("--v3-session-panel-width"');
    expect(workspace).not.toContain("style={{");
    // separator role + keyboard nudge for accessibility.
    expect(workspace).toContain('role="separator"');
    expect(workspace).toContain("onKeyDown={handleResourceResizeKeyDown}");
    expect(workspace).toContain("onKeyDown={handleChatResizeKeyDown}");
  });

  it("places the two resize handles in the grid gap tracks", () => {
    const css = read("./v3-task-board.css");

    expect(css).toMatch(/\.v3-task-board-resize--left\s*{[^}]*grid-column:\s*2;/s);
    expect(css).toMatch(/\.v3-task-board-resize--right\s*{[^}]*grid-column:\s*4;/s);
  });

  it("opens the document overlay at 40% and caps expansion at 95% of the board area (🔴19)", () => {
    const workspace = read("./TaskBoardWorkspace.tsx");
    const css = read("./v3-task-board.css");

    expect(workspace).toContain("is-expanded");
    expect(workspace).toContain("aria-pressed={overlayExpanded}");
    expect(css).toMatch(/\.v3-task-board-document-overlay\s*{[^}]*height:\s*40%;/s);
    // 확장 상한은 보드 영역(grid track) 높이의 95% — 이전 90%를 대체(🔴19).
    expect(css).toMatch(/\.v3-task-board-document-overlay\.is-expanded\s*{[^}]*height:\s*95%;/s);
    expect(css).not.toMatch(/\.v3-task-board-document-overlay\.is-expanded\s*{[^}]*height:\s*90%;/s);
    expect(css).toMatch(/prefers-reduced-motion/);
  });

  it("frames the sessions tab as a session list with reused caller-tree composition", () => {
    const resources = read("./TaskBoardResourcePane.tsx");

    // composition reuses the task panel's run tree + rich rows.
    expect(resources).toContain("buildRunTree");
    expect(resources).toContain("RichSessionRow");
    // sub-delegations stay collapsed by default.
    expect(resources).toContain("useState(false)");
    // no longer framed/labelled as a "delegation relation".
    expect(resources).not.toContain("위임 관계");
    expect(resources).not.toContain("아직 위임된 세션이 없습니다");
  });
});

describe("document overlay animation, close policy, and close button contract", () => {
  it("animates the overlay open/close and defers unmount to the close animation", () => {
    const workspace = read("./TaskBoardWorkspace.tsx");
    const css = read("./v3-task-board.css");

    expect(workspace).toContain("onAnimationEnd={handleOverlayAnimationEnd}");
    expect(workspace).toContain("is-closing");
    expect(workspace).toContain("requestCloseOverlay");
    expect(workspace).toContain("prefersReducedMotion");
    expect(css).toMatch(/@keyframes\s+v3-task-board-overlay-in/);
    expect(css).toMatch(/@keyframes\s+v3-task-board-overlay-out/);
    expect(css).toMatch(/\.v3-task-board-document-overlay\.is-closing\s*{[^}]*animation:/s);
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*animation:\s*none/);
  });

  it("shrinks (not closes) the overlay on central board interactions; only X closes (🔴20)", () => {
    const workspace = read("./TaskBoardWorkspace.tsx");

    // 🔴20: 보드 영역 상호작용은 닫지 않고 기본 높이(40%)로 축소한다.
    expect(workspace).toMatch(/v3-task-board-canvas[\s\S]*onMouseDownCapture=\{\(\) => \{ if \(activeBoardDocumentId\) requestShrinkOverlay\(\); \}\}/);
    expect(workspace).toContain("const requestShrinkOverlay");
    expect(workspace).toContain("setOverlayExpanded(false)");
    // 완전 닫기(requestCloseOverlay)는 X 버튼에만 남는다.
    expect(workspace).toMatch(/data-testid="v3-task-board-document-overlay-close"[\s\S]*onClick=\{requestCloseOverlay\}/);
    // 중앙 캔버스 핸들러는 close가 아니라 shrink를 호출한다.
    expect(workspace).toMatch(/v3-task-board-canvas"[\s\S]{0,200}?onMouseDownCapture=\{\(\) => \{ if \(activeBoardDocumentId\) requestShrinkOverlay\(\); \}\}/);
  });

  it("adds an explicit close button beside the expand/shrink toggle", () => {
    const workspace = read("./TaskBoardWorkspace.tsx");

    expect(workspace).toContain('data-testid="v3-task-board-document-overlay-close"');
    expect(workspace).toContain('data-testid="v3-task-board-document-overlay-expand"');
    // expand/shrink stays a height toggle; close uses the animated path.
    expect(workspace).toContain("onClick={requestCloseOverlay}");
  });

  it("shares the MarkdownDocumentPanel edit surface between board overlay and task panel (🔴17)", () => {
    const boardOverlay = read("./TaskBoardWorkspace.tsx");
    const taskPanelInspector = read("./TaskWorkspace.tsx");

    // Both the board overlay and the (non-board) task detail inspector mount the same shared
    // panel, so the edit/done buttons (🔴16) and the editor focus ring (🔴7) — which live inside
    // MarkdownDocumentPanel — appear identically in both surfaces without a new branch.
    expect(boardOverlay).toContain("<MarkdownDocumentPanel");
    expect(taskPanelInspector).toContain("<MarkdownDocumentPanel");
  });
});

describe("task board editor refine (🔴18~24) contract", () => {
  it("closes the overlay by shrinking its height to zero, not fading out (🔴21)", () => {
    const css = read("./v3-task-board.css");

    // 닫힘 키프레임은 height를 0으로 접는다. translateY/opacity 페이드는 제거한다.
    expect(css).toMatch(/@keyframes\s+v3-task-board-overlay-out\s*{[^}]*height:\s*0;/s);
    expect(css).not.toMatch(/@keyframes\s+v3-task-board-overlay-out\s*{[^}]*translateY/s);
    expect(css).not.toMatch(/@keyframes\s+v3-task-board-overlay-out\s*{[^}]*opacity/s);
    expect(css).toMatch(/\.v3-task-board-document-overlay\.is-closing\s*{[^}]*animation:\s*v3-task-board-overlay-out/s);
  });

  it("makes the overlay top bar a horizontal drag handle clamped to the board (🔴22)", () => {
    const workspace = read("./TaskBoardWorkspace.tsx");
    const css = read("./v3-task-board.css");

    // 탑바(헤더) mousedown이 드래그를 시작하고, 버튼 위 mousedown은 제외한다.
    expect(workspace).toContain("handleOverlayHeaderMouseDown");
    expect(workspace).toMatch(/v3-chat-header"\s+onMouseDown=\{handleOverlayHeaderMouseDown\}/);
    expect(workspace).toContain('closest("button")');
    // 오프셋은 setProperty로만 반영(인라인 style 리터럴 금지 계약 유지).
    expect(workspace).toContain('setProperty("--v3-overlay-offset-x"');
    expect(workspace).not.toContain("style={{");
    // clamp 기준은 보드 영역(canvas) 폭.
    expect(workspace).toContain('querySelector<HTMLElement>(\'[data-testid="v3-task-board-canvas"]\')');
    expect(css).toMatch(/\.v3-task-board-document-overlay\s*{[^}]*left:\s*var\(--v3-overlay-offset-x/s);
    // 새 task-board 토큰을 만들지 않는다.
    expect(css).not.toMatch(/--v3-task-board-[\w-]+\s*:/);
  });

  it("persists and restores the per-task board layout via dashboard-store persist (🔴23)", () => {
    const workspace = read("./TaskBoardWorkspace.tsx");

    // task page id를 키로 기존 persist 슬라이스에 저장·복원한다.
    expect(workspace).toContain("const layoutKey = task.page.id");
    expect(workspace).toContain("setTaskBoardLayout");
    expect(workspace).toContain("taskBoardLayouts");
    // 보드 zoom/pan은 viewportPersistenceKey로 위임한다.
    expect(workspace).toContain("viewportPersistenceKey={layoutKey}");
  });
});

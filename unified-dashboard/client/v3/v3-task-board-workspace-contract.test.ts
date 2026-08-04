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
    // 위임 세션은 기본 노출되고, 페이지 밖 과거 세션에도 도달할 수 있다.
    expect(resources).toContain("useState(true)");
    expect(resources).toContain("v3-task-board-load-more-runs");
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

describe("task board editor refine 3rd round (🔴26~28) contract", () => {
  it("keeps the overlay open when a chat session is selected; only X closes it (🔴26)", () => {
    const workspace = read("./TaskBoardWorkspace.tsx");

    // openSession은 편집 오버레이를 닫지 않는다. 세션 리셋이 비운 activeBoardDocumentId를
    // 같은 이벤트 핸들러 안에서 직전 문서로 복원한다(capture → onOpenSession → restore 순서).
    expect(workspace).toMatch(
      /const openSession = \(session[^)]*\) => \{[\s\S]*?const preservedDocumentId = useDashboardStore\.getState\(\)\.activeBoardDocumentId;[\s\S]*?onOpenSession\(session\);[\s\S]*?if \(preservedDocumentId\) \{[\s\S]*?setActiveBoardDocument\(preservedDocumentId\)/s,
    );
    // 세션 선택 경로가 오버레이를 무조건 닫던 예전 부작용(널 세팅 후 세션 열기)은 제거한다.
    expect(workspace).not.toMatch(
      /openSession = \(session[^)]*\) => \{\s*useDashboardStore\.getState\(\)\.setActiveBoardDocument\(null\);\s*onOpenSession/s,
    );
    // 완전 닫기는 여전히 X 버튼(requestCloseOverlay)에만 있다(🔴20 축소와 공존).
    expect(workspace).toMatch(
      /data-testid="v3-task-board-document-overlay-close"[\s\S]*onClick=\{requestCloseOverlay\}/,
    );
  });

  it("moves the overlay top bar with 1:1 clamp parity via incremental delta (🔴27)", () => {
    const workspace = read("./TaskBoardWorkspace.tsx");

    // 매 mousemove에서 직전 clientX 대비 증분을 clamp된 현재 오프셋에 적용해 재기준화한다.
    expect(workspace).toContain("const deltaX = moveEvent.clientX - lastX;");
    expect(workspace).toContain("applyOverlayOffset(overlayOffsetRef.current + deltaX)");
    // clamp 한도 너머 입력이 누적되던 startOffset+전체델타 계산은 제거한다.
    expect(workspace).not.toContain("startOffset + (moveEvent.clientX - startX)");
    // clamp 기준(보드 canvas 폭)·setProperty 반영은 유지.
    expect(workspace).toContain('setProperty("--v3-overlay-offset-x"');
  });

  it("rounds the overlay frame with the shared liquid-glass radius token (🔴28)", () => {
    const css = read("./v3-task-board.css");

    // 오버레이 프레임을 카드 코너 반경(--liquid-glass-radius)에 맞춰 둥글게 clip한다(신규 토큰 없음).
    expect(css).toMatch(
      /\.v3-task-board-document-overlay\s*{[^}]*border-radius:\s*var\(--liquid-glass-radius[^}]*overflow:\s*hidden;/s,
    );
    expect(css).not.toMatch(/--v3-task-board-[\w-]+\s*:/);
  });
});

describe("task board session list context menu (🔴30) contract", () => {
  it("wires the session rows to the shared context-menu callback", () => {
    const resources = read("./TaskBoardResourcePane.tsx");

    // 세션 행(RichSessionRow)이 우클릭 핸들러를 받아 연결한다(폴더 보드 세션 카드와 일관).
    expect(resources).toContain("onSessionContextMenu");
    expect(resources).toContain("onContextMenu={onSessionContextMenu}");
    // 트리 → 노드 → 행으로 콜백을 스레딩한다(직접 자식·하위 위임 모두).
    expect(resources).toMatch(/onSessionContextMenu\?\(session: SessionSummary, event: MouseEvent<HTMLDivElement>\): void;/);
  });

  it("reuses the canonical SessionContextMenu, actions, and dialogs in the board (🔴30)", () => {
    const workspace = read("./TaskBoardWorkspace.tsx");

    // 업무 패널(TaskRunHistory)과 동일한 공통 컴포넌트·액션 배선을 재사용한다.
    expect(workspace).toContain("<SessionContextMenu");
    expect(workspace).toContain("onRenameSession={onRenameSession}");
    expect(workspace).toContain("onDeleteSessions={onDeleteSessions}");
    expect(workspace).toContain("getRunSessionRenamePrefill(sessions, sessionId)");
    expect(workspace).toContain("buildTaskSessionExtraActions");
    expect(workspace).toContain("onSessionContextMenu={openSessionContextMenu}");
    // 이어서 새 세션은 우클릭한 세션을 대상으로 승계 모달을 연다.
    expect(workspace).toContain("currentSession={targetedSuccession}");
    // 다른 업무로 이동은 기존 TaskMoveDialog 정본을 재사용한다.
    expect(workspace).toContain("<TaskMoveDialog");
    expect(workspace).toContain("await onMoveSession(moveSessionId, target)");
    // 우클릭 메뉴는 별도 인라인 style·svg를 만들지 않는다(계약 유지).
    expect(workspace).not.toContain("style={{");
  });

  it("threads the session mutation callbacks from TaskWorkspace into the board (🔴30)", () => {
    const taskWorkspace = read("./TaskWorkspace.tsx");

    // 예전엔 TaskDetailPane에만 전달하던 콜백을 보드 워크스페이스에도 전달한다.
    expect(taskWorkspace).toMatch(
      /<TaskBoardWorkspace[\s\S]*?onRenameSession=\{onRenameSession\}[\s\S]*?onDeleteSessions=\{onDeleteSessions\}[\s\S]*?onMoveSession=\{onMoveSession\}[\s\S]*?\/>/,
    );
  });
});

import fs from 'node:fs';
import path from 'node:path';
import type { DesignTokens } from '../tokens';
import {
  DARK_COLORS,
  DESIGN_SPACING,
  PHONE_CARD_LAYOUT,
  PHONE_FOUNDATION,
  TABLET_CARD_LAYOUT,
  TABLET_FOUNDATION,
  TABLET_SPACING,
} from '../tokens';
import { createPlannerVisualRoles } from '../plannerVisualRoles';

const SRC_ROOT = path.resolve(__dirname, '../..');

describe('N3 planner visual roles', () => {
  test.each([
    ['phone', PHONE_FOUNDATION],
    ['tablet', TABLET_FOUNDATION],
  ] as const)('%s에서 플래너 규격을 semantic foundation에 연결한다', (_device, foundation) => {
    const roles = createPlannerVisualRoles(tokens(foundation));

    expect(roles.pageInset).toBe(20);
    expect(roles.projectIndent).toBe(24);
    expect(roles.contentIconFrame).toBe(24);
    expect(roles.disclosureVisual).toBe(16);
    expect(roles.actionColumn).toBe(foundation.hitTarget);
    expect(roles.statusColumn).toBe(foundation.minHeight.row);
    expect(roles.minHeight).toEqual({
      context: 52,
      row: 64,
      folder: 80,
      memo: 112,
    });
    expect(roles.typography).toBe(foundation.typography);
    expect(roles.sectionRhythm).toEqual(_device === 'tablet'
      ? { before: 16, after: 12 }
      : { before: 12, after: 8 });
    expect(roles.sidebar).toEqual({
      contentInset: 20,
      sectionGap: 16,
      firstItemPullUp: 8,
    });
  });

  test('업무 상태는 title→status→meta 위계를 위한 semantic 색을 제공한다', () => {
    const roles = createPlannerVisualRoles(tokens(PHONE_FOUNDATION));

    expect(roles.statusTone).toEqual({
      open: DARK_COLORS.textTertiary,
      in_progress: DARK_COLORS.accent,
      review: DARK_COLORS.warning,
      completed: DARK_COLORS.success,
    });
  });

  test('N3 표면에 N7 공통 행·sheet·tree를 더한 20 files / 25 units는 미할당 0이다', () => {
    const expected = new Map<string, string[]>([
      ['components/planner/DailyMemo.tsx', ['DailyMemo']],
      ['components/planner/PlannerMarkdownText.tsx', ['PlannerMarkdownText']],
      ['components/planner/PlannerFolderRow.tsx', ['PlannerFolderRow']],
      ['components/planner/GroupedGlassSheet.tsx', ['GroupedGlassSheet', 'GroupedGlassRow']],
      ['components/planner/ProjectTreeSheet.tsx', ['ProjectTreeSheet']],
      ['components/planner/ProjectContextEditorView.tsx', ['ProjectContextEditorView']],
      ['components/planner/StarredFolderList.tsx', ['StarredFolderList']],
      ['components/planner/TabletMarkdownEditor.tsx', ['TabletMarkdownEditor']],
      ['components/planner/FolderBoardContent.tsx', ['FolderBoardContent', 'FolderBoardItemCard', 'InlineMarkdown', 'InlineCustomView']],
      ['components/planner/FolderCards.tsx', ['FolderCards']],
      ['components/planner/FolderDefaultAssignment.tsx', ['FolderDefaultAssignment']],
      ['components/planner/FolderSessionHistory.tsx', ['FolderSessionHistory']],
      ['components/planner/FolderWorkspace.tsx', ['FolderWorkspace']],
      ['components/planner/FolderWorkspaceReadOverlay.tsx', ['FolderWorkspaceReadOverlay']],
      ['screens/DailyPlannerScreen.tsx', ['DailyPlannerScreen']],
      ['screens/ProjectListScreen.tsx', ['ProjectHeaderAddButton', 'ProjectListScreen']],
      ['components/planner/FolderWorkspaceSections.tsx', ['FolderWorkspaceSections']],
      ['screens/StarredFoldersScreen.tsx', ['StarredFoldersScreen']],
      ['components/planner/projectManagement.ts', ['showProjectManagement']],
      ['hooks/usePlannerContextMenus.ts', ['usePlannerContextMenus']],
    ]);

    expect(expected.size).toBe(20);
    expect([...expected.values()].flat()).toHaveLength(25);
    for (const [file, units] of expected) {
      const source = fs.readFileSync(path.join(SRC_ROOT, file), 'utf8');
      for (const unit of units) {
        expect(source).toMatch(new RegExp(`(?:function|const)\\s+${unit}\\b|export\\s+function\\s+${unit}\\b`));
      }
    }
  });
});

function tokens(foundation: typeof PHONE_FOUNDATION | typeof TABLET_FOUNDATION): DesignTokens {
  const tablet = foundation === TABLET_FOUNDATION;
  return {
    mode: 'dark',
    colors: DARK_COLORS,
    foundation,
    hitTarget: { min: foundation.hitTarget },
    spacing: tablet ? TABLET_SPACING : DESIGN_SPACING,
    uiSpacing: DESIGN_SPACING,
    cardLayout: tablet ? TABLET_CARD_LAYOUT : PHONE_CARD_LAYOUT,
  } as DesignTokens;
}

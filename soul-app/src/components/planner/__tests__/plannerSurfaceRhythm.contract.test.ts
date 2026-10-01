import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '../../..');

function read(file: string) {
  return fs.readFileSync(path.join(SRC_ROOT, file), 'utf8');
}

describe('N3 production planner surface rhythm', () => {
  test('각 시각 표면은 planner visual role 정본을 직접 소비한다', () => {
    for (const file of [
      'components/planner/DailyMemo.tsx',
      'components/planner/PlannerMarkdownText.tsx',
      'components/planner/PlannerFolderRow.tsx',
      'components/planner/GroupedGlassSheet.tsx',
      'components/planner/ProjectContextEditor.tsx',
      'components/planner/StarredFolderList.tsx',
      'components/planner/TabletMarkdownEditor.tsx',
      'components/planner/FolderBoardContent.tsx',
      'components/planner/Card.styles.ts',
      'components/planner/FolderDefaultAssignment.tsx',
      'components/planner/FolderSessionHistory.tsx',
      'components/planner/FolderWorkspace.styles.ts',
      'components/planner/FolderWorkspaceDetails.tsx',
      'components/planner/FolderWorkspaceReadOverlay.tsx',
      'screens/DailyPlannerScreen.tsx',
      'screens/ProjectListScreen.tsx',
      'components/planner/FolderWorkspaceSections.tsx',
      'screens/StarredFoldersScreen.tsx',
    ]) {
      expect(read(file)).toContain('createPlannerVisualRoles');
    }
  });

  test('24pt content frame와 semantic minHeight를 쓰고 고정 task/memo height를 만들지 않는다', () => {
    const folderCard = read('components/planner/PlannerFolderRow.tsx');
    const board = read('components/planner/FolderBoardContent.tsx');
    const cards = read('components/planner/Card.styles.ts');
    const workspace = read('components/planner/FolderWorkspace.styles.ts');
    const workspaceDetails = read('components/planner/FolderWorkspaceDetails.tsx');

    expect(folderCard).toContain('minHeight: planner.minHeight.folder');
    expect(folderCard).not.toMatch(/\bheight:\s*planner\.minHeight\.folder/);
    for (const source of [folderCard, board, workspaceDetails]) {
      expect(source).toContain('planner.contentIconFrame');
    }
    for (const source of [board]) {
      expect(source).toMatch(/disclosureFrame:\s*\{[\s\S]*width:\s*planner\.actionColumn,[\s\S]*height:\s*planner\.actionColumn/);
    }
    expect(cards).toContain('minHeight: planner.minHeight.row');
    expect(workspace).toContain('minHeight: planner.minHeight.memo');
    expect(workspace).not.toMatch(/\bheight:\s*planner\.minHeight\.memo/);
  });

  test('FolderSessionHistory는 N3 시각 역할을 보존하면서 N4 offline projection을 소비한다', () => {
    const source = read('components/planner/FolderSessionHistory.tsx');
    expect(source).toContain('createPlannerVisualRoles');
    expect(source).toContain('useNodeConnectivityStore');
    expect(source).toContain('projectVisibleSessions');
  });
});

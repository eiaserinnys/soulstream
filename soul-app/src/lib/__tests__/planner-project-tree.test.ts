import type { Folder } from '../../api/types';
import {
  buildPlannerProjectTreeRows,
  plannerProjectSortKey,
} from '../planner-project-tree';

function folder(
  id: string,
  name: string,
  parentFolderId: string | null = null,
): Folder {
  return { id, name, parentFolderId, projectPageId: `page-${id}`, sortOrder: 0 };
}

test('선행 이모지·공백·기호를 모두 건너뛴 첫 유효 문자로 안정 정렬한다', () => {
  expect(plannerProjectSortKey('🧪   Alpha')).toBe('Alpha');
  expect(plannerProjectSortKey('👨‍👩‍👧‍👦  Family')).toBe('Family');
  expect(plannerProjectSortKey('  ⭐ · 📁  Gamma')).toBe('Gamma');
  expect(plannerProjectSortKey('— ◇  가나다')).toBe('가나다');
  expect(plannerProjectSortKey('✨  10 Tools')).toBe('10 Tools');
  expect(plannerProjectSortKey('1️⃣  Delta')).toBe('Delta');
  expect(plannerProjectSortKey('   Beta')).toBe('Beta');
  expect(plannerProjectSortKey('Alpha ⭐')).toBe('Alpha ⭐');
  expect(plannerProjectSortKey('⭐ · ')).toBe('');

  const rows = buildPlannerProjectTreeRows([
    folder('same-a', '⭐ Same'),
    folder('beta', '🧪 Beta'),
    folder('same-b', 'Same'),
    folder('alpha', '  Alpha'),
    folder('gamma', '⭐ · 📁 Gamma'),
  ]);
  expect(rows.map((row) => row.folder.id)).toEqual([
    'alpha',
    'beta',
    'gamma',
    'same-a',
    'same-b',
  ]);
});

test('기본 접힘, 부모 바로 아래 depth, 고아와 순환 root 격리를 보장한다', () => {
  const folders = [
    folder('parent', 'Parent'),
    folder('child', 'Child', 'parent'),
    folder('grandchild', 'Grandchild', 'child'),
    folder('orphan', 'Orphan', 'missing'),
    folder('cycle-a', 'Cycle A', 'cycle-b'),
    folder('cycle-b', 'Cycle B', 'cycle-a'),
  ];

  const collapsed = buildPlannerProjectTreeRows(folders);
  expect(collapsed.map((row) => row.folder.id)).toEqual([
    'cycle-a', 'cycle-b', 'orphan', 'parent',
  ]);
  expect(collapsed.find((row) => row.folder.id === 'parent')).toMatchObject({
    depth: 0,
    hasChildren: true,
    isExpanded: false,
  });

  const expanded = buildPlannerProjectTreeRows(
    folders,
    new Set(['parent', 'child']),
  );
  expect(expanded.map((row) => [row.folder.id, row.depth])).toEqual([
    ['cycle-a', 0],
    ['cycle-b', 0],
    ['orphan', 0],
    ['parent', 0],
    ['child', 1],
    ['grandchild', 2],
  ]);
});

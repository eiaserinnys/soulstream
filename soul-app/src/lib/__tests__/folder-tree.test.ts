import type { Folder } from '../../api/types';
import {
  buildFolderMoveItems,
  buildFolderMoveTargets,
  buildFolderSiblingReorderItems,
  buildFolderTreeRows,
  folderTreeIndent,
  formatFolderDepthLabel,
  isFolderMoveBlocked,
} from '../folder-tree';

const folders: Folder[] = [
  { id: 'root-b', name: 'Root B', sortOrder: 20, parentFolderId: null },
  { id: 'root-a', name: 'Root A', sortOrder: 10, parentFolderId: null },
  { id: 'child-a2', name: 'Child A2', sortOrder: 20, parentFolderId: 'root-a' },
  { id: 'child-a1', name: 'Child A1', sortOrder: 10, parentFolderId: 'root-a' },
  { id: 'grand-a1', name: 'Grand A1', sortOrder: 10, parentFolderId: 'child-a1' },
];

describe('folder-tree', () => {
  test('iPad projection renders every nested folder in sorted tree order', () => {
    const rows = buildFolderTreeRows(folders, { expandAll: true });

    expect(rows.map((row) => [row.folder.id, row.depth])).toEqual([
      ['root-a', 0],
      ['child-a1', 1],
      ['grand-a1', 2],
      ['child-a2', 1],
      ['root-b', 0],
    ]);
    expect(rows[0]).toEqual(
      expect.objectContaining({ hasChildren: true, isExpanded: true }),
    );
  });

  test('iPhone projection only renders descendants of expanded folders', () => {
    const rows = buildFolderTreeRows(folders, {
      expandedFolderIds: new Set(['root-a']),
    });

    expect(rows.map((row) => [row.folder.id, row.depth])).toEqual([
      ['root-a', 0],
      ['child-a1', 1],
      ['child-a2', 1],
      ['root-b', 0],
    ]);
    expect(rows.find((row) => row.folder.id === 'child-a1')).toEqual(
      expect.objectContaining({ hasChildren: true, isExpanded: false }),
    );
  });

  test('move guard blocks self and descendant targets but allows root and siblings', () => {
    expect(isFolderMoveBlocked(folders, 'root-a', 'root-a')).toBe(true);
    expect(isFolderMoveBlocked(folders, 'root-a', 'grand-a1')).toBe(true);
    expect(isFolderMoveBlocked(folders, 'root-a', 'root-b')).toBe(false);
    expect(isFolderMoveBlocked(folders, 'root-a', null)).toBe(false);
  });

  test('move targets expose tree labels and disabled invalid descendants', () => {
    const targets = buildFolderMoveTargets(folders, 'root-a');

    expect(targets.map((target) => [target.folderId, target.label, target.disabled])).toEqual([
      [null, '최상위 폴더', true],
      ['root-a', 'Root A', true],
      ['child-a1', '› Child A1', true],
      ['grand-a1', '› › Grand A1', true],
      ['child-a2', '› Child A2', true],
      ['root-b', 'Root B', false],
    ]);
  });

  test('moving a folder rewrites source and target sibling sort orders', () => {
    expect(buildFolderMoveItems(folders, 'child-a2', 'root-b')).toEqual([
      { id: 'child-a1', sortOrder: 0, parentFolderId: 'root-a' },
      { id: 'child-a2', sortOrder: 0, parentFolderId: 'root-b' },
    ]);
  });

  test('sibling reorder swaps within the same parent only', () => {
    expect(buildFolderSiblingReorderItems(folders, 'root-b', 'up')).toEqual([
      { id: 'root-b', sortOrder: 0, parentFolderId: null },
      { id: 'root-a', sortOrder: 1, parentFolderId: null },
    ]);
    expect(buildFolderSiblingReorderItems(folders, 'root-a', 'up')).toBeNull();
  });

  test('labels and indentation cap deep nesting without shrinking rows', () => {
    expect(formatFolderDepthLabel('Grand A1', 2)).toBe('› › Grand A1');
    expect(folderTreeIndent(7, 16, 5)).toBe(80);
  });
});

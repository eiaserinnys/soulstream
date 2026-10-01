import type { PlannerFolder } from '../../api/plannerTypes';
import type { Folder } from '../../api/types';
import { groupPlannerFoldersByParent } from '../planner-folder-groups';

function folder(id: string, parentFolderId: string | null): PlannerFolder {
  return {
    page: { id, title: id },
    parentFolderId,
  } as PlannerFolder;
}

const folders = [
  { id: 'a', name: '🧪 Alpha', projectPageId: 'project-a' },
  { id: 'b', name: 'Beta', projectPageId: 'project-b' },
] as Folder[];

test('데일리 업무를 프로젝트 구분자 아래 묶고 미연결 업무를 잃지 않는다', () => {
  const groups = groupPlannerFoldersByParent([
    folder('a-1', 'a'),
    folder('none', null),
    folder('a-2', 'a'),
    folder('missing', 'missing-folder'),
    folder('missing-2', 'another-missing-folder'),
    folder('b-1', 'b'),
  ], folders);

  expect(groups.map((group) => [
    group.title,
    group.folders.map((item) => item.page.id),
  ])).toEqual([
    ['🧪 Alpha', ['a-1', 'a-2']],
    ['상위 폴더 없음', ['none']],
    ['연결되지 않은 폴더', ['missing']],
    ['연결되지 않은 폴더', ['missing-2']],
    ['Beta', ['b-1']],
  ]);
});

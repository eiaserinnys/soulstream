import type { Folder } from '../../../api/types';
import {
  buildNewFolderSubmission,
  projectOptionsFromFolders,
} from '../newFolderCreation';

const folders: Folder[] = [
  { id: 'plain', name: '일반 폴더', sortOrder: 0, projectPageId: null },
  { id: 'project-a', name: '프로젝트 A', sortOrder: 1, projectPageId: 'page-a' },
  { id: 'project-b', name: '프로젝트 B', sortOrder: 2, projectPageId: 'page-b' },
];

test('업무 생성 프로젝트 선택지는 projectPageId가 있는 폴더만 사용한다', () => {
  expect(projectOptionsFromFolders(folders)).toEqual([
    { folderId: 'project-a', projectPageId: 'page-a', name: '프로젝트 A' },
    { folderId: 'project-b', projectPageId: 'page-b', name: '프로젝트 B' },
  ]);
});

test('제목·설명·프로젝트를 생성 계약으로 만든다', () => {
  const initialContext = {
    guidance: '업무 지침',
    atomReferences: [],
    sessionDefaults: { agentId: 'roselin_codex', nodeId: 'eiaserinnys' },
  };
  expect(buildNewFolderSubmission({
    title: ' 새 업무 ',
    description: '설명',
    selectedProjectPageId: 'page-a',

    initialContext,
  }, projectOptionsFromFolders(folders))).toEqual({
    title: '새 업무',
    description: '설명',
    folderId: 'project-a',
    projectPageId: 'page-a',
    initialContext,
  });
});

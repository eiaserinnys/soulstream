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
    parent: projectOptionsFromFolders(folders).find((option) => option.projectPageId === 'page-a'),
    initialContext,
  })).toEqual({
    title: '새 업무',
    description: '설명',
    folderId: 'project-a',
    projectPageId: 'page-a',
    initialContext,
  });
});

test('최상위 새 폴더는 상위 없이 같은 생성 계약을 쓰고, 고른 상위가 사라졌으면 막는다', () => {
  const initialContext = { guidance: '', atomReferences: [] };
  expect(buildNewFolderSubmission({ title: '최상위', description: '', parent: null, initialContext })).toEqual({
    title: '최상위', description: '', folderId: null, projectPageId: null, initialContext,
  });
  expect(() => buildNewFolderSubmission({ title: '하위', description: '', parent: undefined, initialContext }))
    .toThrow('상위 폴더를 선택');
});

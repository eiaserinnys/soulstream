import type { Folder } from '../../api/types';
import type { InitialFolderContext } from '../../api/initialFolderContext';

export interface ProjectFolderOption {
  folderId: string;
  projectPageId: string;
  name: string;
}

export function projectOptionsFromFolders(
  folders: readonly Folder[],
): ProjectFolderOption[] {
  return folders
    .filter((folder): folder is Folder & { projectPageId: string } => (
      typeof folder.projectPageId === 'string' && Boolean(folder.projectPageId.trim())
      && !folder.archived && folder.id !== 'claude' && folder.id !== 'llm'
    ))
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((folder) => ({
      folderId: folder.id,
      projectPageId: folder.projectPageId,
      name: folder.name,
    }));
}

export function buildNewFolderSubmission(input: {
  title: string;
  description: string;
  /** null creates a top-level folder; undefined means the chosen parent is missing. */
  parent: ProjectFolderOption | null | undefined;
  initialContext: InitialFolderContext;
}) {
  const title = input.title.trim();
  if (!title) throw new Error('폴더 이름을 입력해 주세요.');
  if (input.parent === undefined) throw new Error('폴더를 만들 상위 폴더를 선택해 주세요.');
  return {
    title,
    description: input.description,
    folderId: input.parent?.folderId ?? null,
    projectPageId: input.parent?.projectPageId ?? null,
    initialContext: input.initialContext,
  };
}

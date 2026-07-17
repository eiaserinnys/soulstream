import type { CatalogFolder, CatalogFolderReorderItem } from "@seosoyoung/soul-ui";

type ReadFolders = () => readonly CatalogFolder[];

export async function renameProjectFolder(
  folder: CatalogFolder,
  title: string,
  rename: (folderId: string, title: string) => Promise<void>,
  readFolders: ReadFolders,
): Promise<void> {
  await rename(folder.id, title);
  if (readFolders().find((candidate) => candidate.id === folder.id)?.name !== title) {
    throw new Error("프로젝트 이름 변경이 서버에서 거절되었습니다");
  }
}

export async function deleteProjectFolder(
  folder: CatalogFolder,
  remove: (folderId: string) => Promise<void>,
  readFolders: ReadFolders,
): Promise<void> {
  await remove(folder.id);
  if (readFolders().some((candidate) => candidate.id === folder.id)) {
    throw new Error("프로젝트 삭제가 서버에서 거절되었습니다");
  }
}

export async function reorderProjectFolders(
  items: CatalogFolderReorderItem[],
  reorder: (items: CatalogFolderReorderItem[]) => Promise<void>,
  readFolders: ReadFolders,
): Promise<void> {
  await reorder(items);
  const folders = new Map(readFolders().map((folder) => [folder.id, folder]));
  const rejected = items.some((item) => {
    const folder = folders.get(item.id);
    return !folder
      || (folder.parentFolderId ?? null) !== (item.parentFolderId ?? null)
      || folder.sortOrder !== item.sortOrder;
  });
  if (rejected) throw new Error("프로젝트 이동이 서버에서 거절되었습니다");
}

import { FolderMessageError } from "./folder-messages";
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
    throw new FolderMessageError("folders.errors.renameRejected");
  }
}

export async function archiveProjectFolder(
  folder: CatalogFolder,
  remove: (folderId: string) => Promise<void>,
  readFolders: ReadFolders,
): Promise<void> {
  await remove(folder.id);
  if (!readFolders().find((candidate) => candidate.id === folder.id)?.archived) {
    throw new FolderMessageError("folders.errors.archiveRejected");
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
  if (rejected) throw new FolderMessageError("folders.errors.moveRejected");
}

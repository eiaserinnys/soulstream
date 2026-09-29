import {
  buildFolderTreeOptions,
  type CatalogFolder,
  type FolderTreeOption,
} from "@seosoyoung/soul-ui";

export function folderParentOptions(
  folders: readonly CatalogFolder[],
  currentFolderId: string | null,
): FolderTreeOption[] {
  return buildFolderTreeOptions(folders).filter(({ folder }) => (
    folder.id !== currentFolderId
    && typeof folder.projectPageId === "string"
    && folder.projectPageId.trim().length > 0
  ));
}

import type { SessionStatisticsReadRequest } from "./session_statistics_types.js";

export function visibleProject(
  visibleFolders: SessionStatisticsReadRequest["visibleFolders"],
  sourceFolderId: string | null,
): { id: string; label: string } | null {
  if (sourceFolderId === null) return null;
  return resolveVisibleProject(sourceFolderId, new Map(visibleFolders.map((folder) => [folder.id, folder])));
}

export function resolveVisibleProject(
  sourceFolderId: string,
  visibleFolderById: ReadonlyMap<string, SessionStatisticsReadRequest["visibleFolders"][number]>,
): { id: string; label: string } | null {
  let current = visibleFolderById.get(sourceFolderId);
  if (current === undefined) return null;
  while (typeof current.parentFolderId === "string") {
    const parent = visibleFolderById.get(current.parentFolderId);
    if (parent === undefined) break;
    current = parent;
  }
  const label = current.name;
  if (typeof label !== "string") {
    throw new Error("session statistics visible project name is invalid");
  }
  return { id: current.id, label };
}

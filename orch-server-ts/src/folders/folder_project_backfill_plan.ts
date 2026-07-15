export interface BackfillFolderCandidate {
  id: string;
  name: string;
}

export interface BackfillPageCandidate {
  id: string;
  title: string;
  daily: boolean;
  taskIdentity: boolean;
  boundFolderId: string | null;
}

export interface FolderProjectBackfillPlan {
  reuse: Array<{
    folderId: string;
    folderName: string;
    pageId: string;
    pageTitle: string;
    disposition: "exact" | "folder-title-wins";
  }>;
  create: Array<{ folderId: string; folderName: string; pageId: string }>;
  ambiguous: Array<{
    folderId: string;
    folderName: string;
    pageIds: string[];
  }>;
}

export function planFolderProjectBackfill(
  folders: readonly BackfillFolderCandidate[],
  pages: readonly BackfillPageCandidate[],
): FolderProjectBackfillPlan {
  const available = pages.filter((page) => (
    !page.daily && !page.taskIdentity && page.boundFolderId === null
  ));
  const reuse: FolderProjectBackfillPlan["reuse"] = [];
  const create: FolderProjectBackfillPlan["create"] = [];
  const ambiguous: FolderProjectBackfillPlan["ambiguous"] = [];
  for (const folder of folders) {
    const normalized = normalizeProjectTitle(folder.name);
    const matches = available.filter((page) => normalizeProjectTitle(page.title) === normalized);
    if (matches.length === 0) {
      create.push({ folderId: folder.id, folderName: folder.name, pageId: folder.id });
    } else if (matches.length === 1) {
      const page = matches[0]!;
      reuse.push({
        folderId: folder.id,
        folderName: folder.name,
        pageId: page.id,
        pageTitle: page.title,
        disposition: page.title.trim() === folder.name.trim() ? "exact" : "folder-title-wins",
      });
    } else {
      ambiguous.push({
        folderId: folder.id,
        folderName: folder.name,
        pageIds: matches.map((page) => page.id).sort(),
      });
    }
  }
  return { reuse, create, ambiguous };
}

export function normalizeProjectTitle(value: string): string {
  return value
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("ko-KR");
}

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
    reason: "folder-id-collision" | "multiple-title-matches" | "shared-title-match";
  }>;
}

export function planFolderProjectBackfill(
  folders: readonly BackfillFolderCandidate[],
  pages: readonly BackfillPageCandidate[],
): FolderProjectBackfillPlan {
  const available = pages.filter((page) => (
    !page.daily && !page.taskIdentity && page.boundFolderId === null
  ));
  const availableIds = new Set(available.map((page) => page.id));
  const folderIds = new Set(folders.map((folder) => folder.id));
  const titleCounts = new Map<string, number>();
  for (const folder of folders) {
    const key = normalizeProjectTitle(folder.name);
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }
  const reuse: FolderProjectBackfillPlan["reuse"] = [];
  const create: FolderProjectBackfillPlan["create"] = [];
  const ambiguous: FolderProjectBackfillPlan["ambiguous"] = [];
  for (const folder of folders) {
    const normalized = normalizeProjectTitle(folder.name);
    const sameIdPage = pages.find((page) => page.id === folder.id);
    if (sameIdPage) {
      if (!availableIds.has(sameIdPage.id)) {
        ambiguous.push({
          folderId: folder.id,
          folderName: folder.name,
          pageIds: [sameIdPage.id],
          reason: "folder-id-collision",
        });
      } else {
        reuse.push({
          folderId: folder.id,
          folderName: folder.name,
          pageId: sameIdPage.id,
          pageTitle: sameIdPage.title,
          disposition: sameIdPage.title.trim() === folder.name.trim()
            ? "exact"
            : "folder-title-wins",
        });
      }
      continue;
    }
    const matches = available.filter((page) => (
      !folderIds.has(page.id) && normalizeProjectTitle(page.title) === normalized
    ));
    if (matches.length === 0) {
      create.push({ folderId: folder.id, folderName: folder.name, pageId: folder.id });
    } else if (matches.length === 1 && titleCounts.get(normalized) === 1) {
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
        reason: matches.length > 1 ? "multiple-title-matches" : "shared-title-match",
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

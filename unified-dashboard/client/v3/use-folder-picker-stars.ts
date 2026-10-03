import { useEffect, useMemo, useState } from "react";
import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { PageDto } from "@seosoyoung/soul-ui/page";
import { createPlannerDataDependencies, loadStarredFolders, starredFolderPage } from "./planner-data";
import { applyStarredFolderChanges, useFolderStarChanges } from "./folder-star-store";

/** Use the navigation's planner source and optimistic star changes. */
export function useFolderPickerStars(open: boolean, folders: readonly CatalogFolder[], sampleIds?: readonly string[]) {
  const changes = useFolderStarChanges();
  const [pages, setPages] = useState<PageDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (sampleIds) return;
    if (!open) { setPages(null); setError(null); return; }
    let active = true;
    const load = async () => {
      const dependencies = createPlannerDataDependencies();
      const pages: PageDto[] = [];
      let cursor: string | undefined;
      do {
        const result = await loadStarredFolders(dependencies, { cursor });
        pages.push(...result.items.map(starredFolderPage));
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
      if (active) setPages(pages);
    };
    void load().catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [open]);
  const folderIds = useMemo(() => applyStarredFolderChanges(pages ?? [], changes)
    .map((page) => folders.find((folder) => folder.projectPageId === page.id)?.id)
    .filter((id): id is string => Boolean(id)), [pages, changes, folders]);
  return { folderIds: sampleIds ?? folderIds, loading: !sampleIds && open && pages === null && error === null, error };
}

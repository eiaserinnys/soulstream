import { useTranslation } from "react-i18next";
import { folderErrorText } from "./folder-messages";
import { useEffect, useMemo, useState } from "react";
import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { PageDto } from "../../../packages/page-model/src/types";
import { createPlannerDataDependencies, loadStarredFolders, starredFolderPage } from "./planner-data";
import { applyStarredFolderChanges, useFolderStarChanges } from "./folder-star-store";

/** Use the navigation's planner source and optimistic star changes. */
export function useFolderPickerStars(open: boolean, folders: readonly CatalogFolder[], sampleIds?: readonly string[]) {
  const { t } = useTranslation();
  const changes = useFolderStarChanges();
  const [pages, setPages] = useState<PageDto[] | null>(null);
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  useEffect(() => {
    if (sampleIds) return;
    if (!open) { setPages(null); setFailure(null); return; }
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
      if (active) setFailure({ cause });
    });
    return () => { active = false; };
  }, [open]);
  const folderIds = useMemo(() => applyStarredFolderChanges(pages ?? [], changes)
    .map((page) => folders.find((folder) => folder.projectPageId === page.id)?.id)
    .filter((id): id is string => Boolean(id)), [pages, changes, folders]);
  const error = failure ? folderErrorText(t, failure.cause) : null;
  return { folderIds: sampleIds ?? folderIds, loading: !sampleIds && open && pages === null && error === null, error };
}

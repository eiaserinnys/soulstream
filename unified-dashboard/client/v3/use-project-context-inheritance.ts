import { useEffect, useMemo, useState } from "react";
import type { CatalogFolder } from "@seosoyoung/soul-ui";

import {
  beginProjectContextLoad,
  completeProjectContextLoad,
  folderProjectContextSources,
  mergeProjectContextPages,
  type ProjectContextPreviewState,
} from "./project-context-inheritance";
import { fetchProjectPageDetails } from "./project-page-details";

export function useProjectContextInheritance({
  folderId,
  folders,
  invalidationKey = 0,
}: {
  folderId: string;
  folders: readonly CatalogFolder[];
  invalidationKey?: number;
}): ProjectContextPreviewState {
  const resolution = useMemo(
    () => folderProjectContextSources(folderId, folders),
    [folderId, folders],
  );
  const [state, setState] = useState<ProjectContextPreviewState>({
    status: "loading",
    folderId,
    data: null,
    message: null,
  });

  useEffect(() => {
    setState((current) => beginProjectContextLoad(current, folderId, resolution));
    if (resolution.status === "unavailable") return;

    let active = true;
    void Promise.all(resolution.sources.map(async (source) => ({
      source,
      details: await fetchProjectPageDetails(source.pageId),
    }))).then((pages) => {
      if (!active) return;
      const next: Extract<ProjectContextPreviewState, { status: "ready" }> = {
        status: "ready",
        folderId,
        data: mergeProjectContextPages(pages),
        message: null,
      };
      setState((current) => completeProjectContextLoad(current, next));
    }).catch((error: unknown) => {
      if (!active) return;
      setState((current) => current.status === "ready" && current.folderId === folderId
        ? current
        : {
            status: "error",
            folderId,
            data: null,
            message: error instanceof Error && error.message ? error.message : String(error),
          });
    });
    return () => { active = false; };
  }, [folderId, invalidationKey, resolution]);

  return state;
}

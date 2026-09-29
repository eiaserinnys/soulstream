import { useMemo, useState } from "react";
import { createPageApiClient, type PageDto } from "@seosoyoung/soul-ui/page";

import { setFolderStarred } from "./task-star-actions";
import {
  clearFolderStarChange,
  publishFolderStarChange,
  folderStarredState,
  useFolderStarChanges,
} from "./task-star-store";

export function useFolderStar(page: PageDto) {
  const api = useMemo(() => createPageApiClient(), []);
  const changes = useFolderStarChanges();
  const starred = folderStarredState(page.id, changes, page.metadata.starred === true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const nextStarred = !starred;
    const mutationId = publishFolderStarChange({
      page: { ...page, metadata: { ...page.metadata, starred: nextStarred } },
      starred: nextStarred,
    });
    try {
      await setFolderStarred(api, page.id, nextStarred);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : String(cause));
    } finally {
      clearFolderStarChange(page.id, mutationId);
      setPending(false);
    }
  };

  return { starred, pending, error, toggle };
}

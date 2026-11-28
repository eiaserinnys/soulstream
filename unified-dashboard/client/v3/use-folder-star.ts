import { useTranslation } from "react-i18next";
import { folderErrorText } from "./folder-messages";
import { useMemo, useState } from "react";
import type { PageDto } from "../../../packages/page-model/src/types";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";

import { setFolderStarred } from "./folder-star-actions";
import {
  clearFolderStarChange,
  publishFolderStarChange,
  folderStarredState,
  useFolderStarChanges,
} from "./folder-star-store";

export function useFolderStar(page: PageDto) {
  const { t } = useTranslation();
  const api = useMemo(() => createPageApiClient(), []);
  const changes = useFolderStarChanges();
  const starred = folderStarredState(page.id, changes, page.metadata.starred === true);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);

  const toggle = async () => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    const nextStarred = !starred;
    const mutationId = publishFolderStarChange({
      page: { ...page, metadata: { ...page.metadata, starred: nextStarred } },
      starred: nextStarred,
    });
    try {
      await setFolderStarred(api, page.id, nextStarred);
    } catch (cause) {
      clearFolderStarChange(page.id, mutationId);
      setFailure({ cause });
    } finally {
      setPending(false);
    }
  };

  return { starred, pending, error: failure ? folderErrorText(t, failure.cause) : null, toggle };
}

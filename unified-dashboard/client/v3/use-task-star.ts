import { useMemo, useState } from "react";
import { createPageApiClient, type PageDto } from "@seosoyoung/soul-ui/page";

import { setTaskStarred } from "./task-star-actions";
import {
  publishTaskStarChange,
  taskStarredState,
  useTaskStarChanges,
} from "./task-star-store";

export function useTaskStar(page: PageDto) {
  const api = useMemo(() => createPageApiClient(), []);
  const changes = useTaskStarChanges();
  const starred = taskStarredState(page.id, changes, page.metadata.starred === true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const updated = await setTaskStarred(api, page.id, !starred);
      publishTaskStarChange({ page: updated, starred: !starred });
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return { starred, pending, error, toggle };
}

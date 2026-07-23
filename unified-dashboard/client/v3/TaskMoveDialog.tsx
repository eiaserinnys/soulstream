import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@seosoyoung/soul-ui";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import {
  defaultTaskMoveTargets,
  searchTaskMoveTargets,
  type TaskMoveTarget,
} from "./task-move-targets";

export function TaskMoveDialog({
  api,
  currentTaskId,
  defaultTargets,
  open,
  onClose,
  onMove,
}: {
  api: PageApiClient;
  currentTaskId: string;
  defaultTargets: readonly TaskMoveTarget[];
  open: boolean;
  onClose(): void;
  onMove(target: TaskMoveTarget): Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [searchedTargets, setSearchedTargets] = useState<TaskMoveTarget[]>([]);
  const [searchPending, setSearchPending] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [movePending, setMovePending] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const visibleDefaultTargets = useMemo(
    () => defaultTaskMoveTargets(defaultTargets, currentTaskId),
    [currentTaskId, defaultTargets],
  );
  const normalizedQuery = query.trim();
  const options = normalizedQuery ? searchedTargets : visibleDefaultTargets;

  useEffect(() => {
    if (!open || !normalizedQuery) {
      setSearchedTargets([]);
      setSearchPending(false);
      setSearchError(null);
      return;
    }
    let active = true;
    setSearchPending(true);
    setSearchError(null);
    void searchTaskMoveTargets(api, normalizedQuery, currentTaskId)
      .then((targets) => { if (active) setSearchedTargets(targets); })
      .catch((error: unknown) => {
        if (active) setSearchError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => { if (active) setSearchPending(false); });
    return () => { active = false; };
  }, [api, currentTaskId, normalizedQuery, open]);

  const close = () => {
    if (movePending) return;
    setQuery("");
    setMoveError(null);
    onClose();
  };

  const move = async (target: TaskMoveTarget) => {
    if (movePending) return;
    setMovePending(true);
    setMoveError(null);
    try {
      await onMove(target);
      setQuery("");
      onClose();
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : String(error));
    } finally {
      setMovePending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) close(); }}>
      <DialogPopup className="max-w-md">
        <DialogHeader><DialogTitle>다른 업무로 이동</DialogTitle></DialogHeader>
        <DialogPanel>
          <div className="v3-context-picker v3-run-move-picker">
            <div className="v3-context-panel">
              <input
                type="search"
                value={query}
                disabled={movePending}
                aria-label="이동할 업무 검색"
                placeholder="전체 업무 검색…"
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="v3-context-options" data-testid="v3-run-move-targets">
                {options.map((target) => (
                  <button
                    type="button"
                    className="v3-context-option"
                    key={target.taskId}
                    disabled={movePending}
                    onClick={() => { void move(target); }}
                  >
                    <span className="v3-emoji" aria-hidden="true">↪</span>
                    <span><strong>{target.page.title}</strong><small>업무 · {target.taskId.slice(0, 8)}</small></span>
                  </button>
                ))}
                {searchPending ? <p>업무를 검색하는 중…</p> : null}
                {!searchPending && options.length === 0 ? (
                  <p>{normalizedQuery ? "일치하는 업무가 없습니다." : "이동할 수 있는 다른 업무가 없습니다."}</p>
                ) : null}
              </div>
            </div>
          </div>
          {searchError ? <p className="v3-load-error" role="alert">업무 검색 실패 · {searchError}</p> : null}
          {moveError ? <p className="v3-load-error" role="alert">{moveError}</p> : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

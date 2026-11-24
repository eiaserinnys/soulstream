import { useLayoutEffect, useRef } from "react";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@seosoyoung/soul-ui";
import type { McpRevision } from "../../lib/mcp-api";
import { SettingsAlert } from "../config/SettingsListDetail";

export type DeleteTarget = {
  kind: "server" | "profile" | "secret";
  id: string;
  version?: number;
};
export type History = {
  target: "server" | "profile";
  id: string;
  revisions: McpRevision[];
};

export function McpDialogs({
  deleting,
  history,
  nodes,
  busy,
  error,
  profiles,
  reload,
  closeDelete,
  closeHistory,
  remove,
  rollback,
}: {
  deleting: DeleteTarget | null;
  history: History | null;
  nodes: string[];
  busy: boolean;
  error: string;
  profiles: string[];
  reload(): void;
  closeDelete(): void;
  closeHistory(): void;
  remove(target: DeleteTarget): void;
  rollback(id: number): void;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const deleteSnapshot = useRef<{ target: DeleteTarget; error: string; nodes: string[]; profiles: string[] } | null>(null);
  const historySnapshot = useRef<{ target: History; error: string } | null>(null);
  useLayoutEffect(() => {
    if (deleting) deleteSnapshot.current = { target: deleting, error, nodes, profiles };
    if (history) historySnapshot.current = { target: history, error };
  }, [deleting, history, error, nodes, profiles]);
  const deleteContent = deleting ? { target: deleting, error, nodes, profiles } : deleteSnapshot.current;
  const historyContent = history ? { target: history, error } : historySnapshot.current;
  return (
    <>
      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) closeDelete();
        }}
        onOpenChangeComplete={(open) => { if (!open && !deleting) deleteSnapshot.current = null; }}
      >
        <DialogPopup className="approved-dialog" initialFocus={cancelButton}>
          <DialogHeader>
            <DialogTitle>삭제</DialogTitle>
            <DialogDescription>
              “{deleteContent?.target.id}” 항목을 삭제할까요? 사용 중이면 삭제할 수 없습니다.
              {deleteContent?.target.kind === "profile" && deleteContent.nodes.length
                ? ` 소속 노드: ${deleteContent.nodes.join(", ")}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {deleteContent?.error ? (
            <DialogPanel>
              <SettingsAlert>
                {deleteContent.error}
                {deleteContent.error.includes("다시 읽은") ? (
                  <Button type="button" variant="outline" onClick={reload}>
                    다시 읽기
                  </Button>
                ) : null}
                {deleteContent.profiles.length > 0 && deleteContent.error.includes("사용 중인 프로필") ? (
                  <details className="config-advanced">
                    <summary>사용 중인 프로필 전체 <span>{deleteContent.profiles.length}개</span></summary>
                    <p>{deleteContent.profiles.join(", ")}</p>
                  </details>
                ) : null}
              </SettingsAlert>
            </DialogPanel>
          ) : null}
          <DialogFooter>
            <Button
              ref={cancelButton}
              type="button"
              variant="outline"
              onClick={closeDelete}
            >
              취소
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (deleting) remove(deleting);
              }}
            >
              삭제
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={Boolean(history)}
        onOpenChange={(open) => {
          if (!open) closeHistory();
        }}
        onOpenChangeComplete={(open) => { if (!open && !history) historySnapshot.current = null; }}
      >
        <DialogPopup className="approved-dialog" initialFocus={closeButton}>
          <DialogHeader>
            <DialogTitle>되돌리기</DialogTitle>
            <DialogDescription>
              {historyContent?.target.id}의 저장된 판을 고릅니다.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {historyContent?.error ? (
              <SettingsAlert>
                {historyContent.error}
                {historyContent.error.includes("다시 읽은") ? (
                  <Button type="button" variant="outline" onClick={reload}>
                    다시 읽기
                  </Button>
                ) : null}
              </SettingsAlert>
            ) : null}
            {historyContent?.target.revisions.length ? (
              historyContent.target.revisions.map((revision) => (
                <div
                  key={revision.id}
                  className="flex items-center justify-between gap-2 py-2"
                >
                  <span>
                    판 {revision.id} ·{" "}
                    {new Date(revision.created_at).toLocaleString("ko-KR")}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => rollback(revision.id)}
                  >
                    이 판으로 되돌리기
                  </Button>
                </div>
              ))
            ) : (
              <p>저장된 판이 없습니다.</p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              ref={closeButton}
              type="button"
              variant="outline"
              onClick={closeHistory}
            >
              닫기
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

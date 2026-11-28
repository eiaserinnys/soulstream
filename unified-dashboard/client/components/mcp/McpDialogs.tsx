import { useTranslation } from "react-i18next";
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
  const { t, i18n } = useTranslation();
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
            <DialogTitle>{t("mcp.delete")}</DialogTitle>
            <DialogDescription>
              {t("mcp.confirmDelete", { id: deleteContent?.target.id ?? "" })}
              {deleteContent?.target.kind === "profile" && deleteContent.nodes.length
                ? " " + t("mcp.memberNodesValue", { nodes: deleteContent.nodes.join(", ") })
                : ""}
            </DialogDescription>
          </DialogHeader>
          {deleteContent?.error ? (
            <DialogPanel>
              <SettingsAlert>
                {deleteContent.error}
                {deleteContent.error.includes("다시 읽은") ? (
                  <Button type="button" variant="outline" onClick={reload}>
                    {t("mcp.reload")}
                  </Button>
                ) : null}
                {deleteContent.profiles.length > 0 && deleteContent.error.includes("사용 중인 프로필") ? (
                  <details className="config-advanced">
                    <summary>{t("mcp.allUsingProfiles")} <span>{t("mcp.itemCount", { count: deleteContent.profiles.length })}</span></summary>
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
              {t("mcp.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (deleting) remove(deleting);
              }}
            >
              {t("mcp.delete")}
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
            <DialogTitle>{t("mcp.rollback")}</DialogTitle>
            <DialogDescription>
              {t("mcp.chooseRevision", { id: historyContent?.target.id ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {historyContent?.error ? (
              <SettingsAlert>
                {historyContent.error}
                {historyContent.error.includes("다시 읽은") ? (
                  <Button type="button" variant="outline" onClick={reload}>
                    {t("mcp.reload")}
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
                    {t("mcp.revision", { revision: revision.id })} ·{" "}
                    {new Date(revision.created_at).toLocaleString(i18n.resolvedLanguage === "ko" ? "ko-KR" : "en-US")}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => rollback(revision.id)}
                  >
                    {t("mcp.restoreRevision")}
                  </Button>
                </div>
              ))
            ) : (
              <p>{t("mcp.noRevisions")}</p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              ref={closeButton}
              type="button"
              variant="outline"
              onClick={closeHistory}
            >
              {t("mcp.close")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

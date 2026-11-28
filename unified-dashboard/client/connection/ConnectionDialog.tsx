import { useTranslation } from "react-i18next";
import type { AdminTranslate } from "../components/config/admin-translation";
import { useEffect, useRef } from "react";
import "../v3/v3-visual-tokens.css";
import { Wifi, WifiOff, LoaderCircle, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "@seosoyoung/soul-ui/components/ui/dialog";
import type { ConnectionSnapshot } from "./connection-monitor";

function copy({ phase, fresh }: ConnectionSnapshot, t: AdminTranslate) {
  if (phase === "planned")
    return [
      t("admin.connection.plannedTitle"),
      t("admin.connection.plannedDetail"),
      t("admin.connection.preparing"),
      t("admin.connection.plannedResume"),
      t("admin.connection.plannedFooter"),
    ];
  if (phase === "recovering")
    return [
      t("admin.connection.recoveredTitle"),
      t("admin.connection.recoveredDetail"),
      t("admin.connection.restoring"),
      "",
      "",
    ];
  if (phase === "new-version")
    return [
      t("admin.connection.newVersionTitle"),
      t("admin.connection.newVersionDetail"),
      t("admin.connection.connectingNewVersion"),
      t("admin.connection.newVersionResume"),
      t("admin.connection.newVersionWait"),
    ];
  const text = [
    t("admin.connection.disconnectedTitle"),
    t("admin.connection.disconnectedDetail"),
    t("admin.connection.reconnecting"),
    t("admin.connection.resume"),
    "",
  ];
  if (phase === "checking") text[2] = t("admin.connection.checking");
  if (fresh) {
    text[3] =
      t("admin.connection.freshResume");
    text[4] = t("admin.connection.freshWait");
  }
  return text;
}
/** Canonical UI contract: document a3badd2c-3c70-40cc-97b1-a0ecca55a7ac v2. */
export function ConnectionDialog({
  snapshot,
}: {
  snapshot: ConnectionSnapshot;
}) {
  const { t } = useTranslation();
  const open = snapshot.phase !== "connected",
    title = useRef<HTMLHeadingElement>(null),
    popup = useRef<HTMLDivElement>(null);
  const text = copy(snapshot, t);
  useEffect(() => {
    if (!open) return;
    const holdFocus = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node)) {
        event.preventDefault();
        event.stopPropagation();
        title.current?.focus();
      }
    };
    const holdKeys = (event: KeyboardEvent) => {
      // The focused title must not trigger dashboard shortcuts behind the modal.
      event.stopPropagation();
      if (
        ["Escape", "Tab"].includes(event.key) ||
        !popup.current?.contains(event.target as Node)
      ) {
        event.preventDefault();
        title.current?.focus();
      }
    };
    const holdInput = (event: Event) => {
      // This dialog has no editable content; composition must not reach a
      // previously focused input while the non-editable title holds focus.
      event.preventDefault();
      event.stopPropagation();
      title.current?.focus();
    };
    document.addEventListener("pointerdown", holdFocus, true);
    document.addEventListener("keydown", holdKeys, true);
    document.addEventListener("beforeinput", holdInput, true);
    return () => {
      document.removeEventListener("pointerdown", holdFocus, true);
      document.removeEventListener("keydown", holdKeys, true);
      document.removeEventListener("beforeinput", holdInput, true);
    };
  }, [open]);
  return (
    <Dialog
      open={open}
      modal
      disablePointerDismissal
      onOpenChange={(next, event) => {
        if (!next && open) event.cancel();
      }}
    >
      <DialogPopup
        ref={popup}
        className="approved-dialog max-w-sm"
        showCloseButton={false}
        initialFocus={title}
      >
        <DialogHeader>
          <div
            className="dialog-confirm-icon"
            style={
              snapshot.phase === "recovering"
                ? {
                    color: "var(--success)",
                    background:
                      "color-mix(in srgb, var(--success) 9%, transparent)",
                  }
                : undefined
            }
          >
            {snapshot.phase === "recovering" ? (
              <Wifi className="size-5" aria-hidden="true" />
            ) : snapshot.phase === "planned" ||
            snapshot.phase === "new-version" ? (
              <RefreshCw className="size-5" aria-hidden="true" />
            ) : (
              <WifiOff className="size-5" aria-hidden="true" />
            )}
          </div>
          <DialogTitle
            ref={title}
            tabIndex={-1}
            className={
              snapshot.phase === "disconnected" || snapshot.phase === "checking"
                ? "outline-none whitespace-pre-line break-keep [overflow-wrap:anywhere]"
                : "outline-none"
            }
          >
            {text[0]}
          </DialogTitle>
          <DialogDescription>{text[1]}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="dialog-confirm-summary">
            <strong
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="flex items-center gap-[var(--v3-space-2)]"
            >
              <LoaderCircle
                className="size-4 animate-spin"
                aria-hidden="true"
              />
              {text[2]}
            </strong>
            {text[3] ? <span>{text[3]}</span> : null}
          </div>
        </DialogPanel>
        {text[4] ? (
          <DialogFooter variant="bare">
            <p className="text-sm text-muted-foreground">{text[4]}</p>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

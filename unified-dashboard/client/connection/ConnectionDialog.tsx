import { useEffect, useRef } from "react";
import { WifiOff, LoaderCircle, RefreshCw } from "lucide-react";
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

const disconnected = [
  "소울스트림 오케스트레이터와의 연결이 끊겼습니다",
  "일시적인 연결 이상이거나 업데이트가 진행 중일 수 있습니다.",
  "자동으로 다시 연결하고 있습니다",
  "이 화면을 그대로 두세요. 연결이 돌아오면 자동으로 이어집니다.",
  "연결 대기 중에는 작성 중인 내용을 전송하지 않습니다.",
];
function copy({ phase, fresh }: ConnectionSnapshot) {
  if (phase === "planned")
    return [
      "소울스트림 업데이트가 곧 시작됩니다",
      "업데이트 중에는 오케스트레이터와의 연결이 잠시 끊길 수 있습니다.",
      "업데이트를 준비하고 있습니다",
      "이 화면을 그대로 두세요. 연결이 돌아오면 자동으로 이어집니다.",
      "업데이트가 끝날 때까지 현재 화면을 유지합니다.",
    ];
  if (phase === "recovering")
    return [
      "소울스트림 연결이 복구되었습니다",
      "최신 내용을 불러오고 있습니다. 곧 이전 화면으로 돌아갑니다.",
      "화면을 복구하고 있습니다",
      "다시 연결된 내용이 화면에 반영되면 이 안내가 닫힙니다.",
      "현재 화면을 유지한 채 최신 내용을 반영합니다.",
    ];
  if (phase === "new-version")
    return [
      "새 버전으로 연결합니다",
      "새 버전을 적용하기 위해 자동으로 새로고침합니다.",
      "새 버전으로 연결하고 있습니다",
      "새 화면이 열리면 이전 작업을 이어갈 수 있습니다.",
      "새 화면이 열릴 때까지 잠시 기다려 주세요.",
    ];
  const text = [...disconnected];
  if (phase === "checking") text[2] = "연결 상태를 확인하고 있습니다";
  if (fresh) {
    text[3] =
      "이 화면을 그대로 두세요. 연결이 돌아오면 자동으로 화면을 엽니다.";
    text[4] = "화면이 열릴 때까지 잠시 기다려 주세요.";
  }
  return text;
}
/** Canonical UI contract: document a3badd2c-3c70-40cc-97b1-a0ecca55a7ac v2. */
export function ConnectionDialog({
  snapshot,
}: {
  snapshot: ConnectionSnapshot;
}) {
  const open = snapshot.phase !== "connected",
    title = useRef<HTMLHeadingElement>(null),
    popup = useRef<HTMLDivElement>(null);
  const text = copy(snapshot);
  useEffect(() => {
    if (!open) return;
    const holdFocus = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node)) {
        event.preventDefault();
        title.current?.focus();
      }
    };
    document.addEventListener("pointerdown", holdFocus, true);
    return () => document.removeEventListener("pointerdown", holdFocus, true);
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
        onKeyDownCapture={(event) => {
          if (["Escape", "Tab"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            title.current?.focus();
          }
        }}
      >
        <DialogHeader>
          <div className="dialog-confirm-icon">
            {snapshot.phase === "planned" ||
            snapshot.phase === "new-version" ? (
              <RefreshCw className="size-5" aria-hidden="true" />
            ) : (
              <WifiOff className="size-5" aria-hidden="true" />
            )}
          </div>
          <DialogTitle ref={title} tabIndex={-1}>
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
            <span>{text[3]}</span>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <p className="text-sm text-muted-foreground">{text[4]}</p>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

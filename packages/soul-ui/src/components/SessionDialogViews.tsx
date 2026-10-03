import { Trash2 } from "lucide-react";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { safeErrorDetail } from "../lib/safe-error-detail";
export function SessionContinueErrorDialog({ error, onClose }: { error: string | null; onClose(): void }) {
  return (
    <Dialog
      open={error !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="approved-dialog max-w-sm">
        <DialogHeader>
          <DialogTitle>세션 이어서 시작 실패</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="dialog-error-notice" role="alert">
            <p>세션을 이어서 시작하지 못했습니다.</p>
            <p>노드 연결 상태와 실행 환경을 확인한 뒤 다시 시도하세요.</p>
            <details><summary>기술 상세</summary><pre>{safeErrorDetail(error ?? "")}</pre></details>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" onClick={onClose}>
            확인
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
export function SessionDeleteDialog({
  open,
  count,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  count: number;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="approved-dialog max-w-sm">
        <DialogHeader>
          <div className="dialog-confirm-icon"><Trash2 className="size-5" aria-hidden="true"/></div>
          <DialogTitle>세션을 삭제할까요?</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="dialog-confirm-summary"><strong>선택한 세션 {count}개</strong><span>세션과 대화 기록이 삭제됩니다. 되돌릴 수 없습니다.</span></div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            세션 삭제
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

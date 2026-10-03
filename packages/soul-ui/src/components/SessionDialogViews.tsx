import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
export function SessionContinueErrorDialog({ error, onClose }: { error: string | null; onClose(): void }) {
  return (
    <Dialog
      open={error !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>세션 이어서 시작 실패</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <p className="text-sm text-muted-foreground">{error}</p>
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
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>세션 삭제</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <p className="text-sm text-muted-foreground">선택한 세션 {count}개를 삭제합니다.</p>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            삭제
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

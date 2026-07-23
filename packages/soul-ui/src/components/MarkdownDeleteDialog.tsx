import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";

export interface MarkdownDeleteDialogProps {
  open: boolean;
  title: string;
  pending?: boolean;
  error?: string | null;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}

export function MarkdownDeleteDialog({
  open,
  title,
  pending = false,
  error,
  onOpenChange,
  onConfirm,
}: MarkdownDeleteDialogProps) {
  const visibleTitle = title.trim() || "제목 없는 문서";
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!pending) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>문서 삭제</DialogTitle>
          <DialogDescription>
            &lsquo;{visibleTitle}&rsquo; 문서를 삭제하시겠습니까? 삭제한 문서는 되돌릴 수 없습니다.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <DialogPanel>
            <p className="text-sm text-destructive" role="alert">{error}</p>
          </DialogPanel>
        ) : null}
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending ? "삭제 중…" : "삭제"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

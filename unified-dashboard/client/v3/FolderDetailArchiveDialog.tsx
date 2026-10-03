import {
  Button,
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@seosoyoung/soul-ui";
export function FolderDetailArchiveDialog({
  open,
  onOpenChange,
  title,
  error,
  onArchive,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  error: string | null;
  onArchive(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>폴더 보관</DialogTitle>
          <DialogDescription>‘{title}’ 폴더를 보관합니다. 내용과 세션은 보존됩니다.</DialogDescription>
        </DialogHeader>
        {error ? <p role="alert">폴더 보관 실패 · {error}</p> : null}
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button type="button" variant="destructive" onClick={onArchive}>
            보관
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

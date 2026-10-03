import {
  Button, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle,
  type CatalogFolder,
} from "@seosoyoung/soul-ui";

export function FolderArchiveDialog({ folder, onClose, onArchive }: {
  folder: CatalogFolder | null;
  onClose(): void;
  onArchive(folder: CatalogFolder): void;
}) {
  return <Dialog open={folder !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogPopup className="approved-dialog max-w-sm">
      <DialogHeader>
        <DialogTitle>폴더를 보관할까요?</DialogTitle>
        <DialogDescription>
          &lsquo;{folder?.name ?? ""}&rsquo; 폴더를 보관합니다. 내용과 세션은 보존됩니다.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter variant="bare">
        <Button type="button" variant="outline" onClick={onClose}>취소</Button>
        <Button type="button" variant="default" onClick={() => {
          if (folder) onArchive(folder);
        }}>폴더 보관</Button>
      </DialogFooter>
    </DialogPopup>
  </Dialog>;
}

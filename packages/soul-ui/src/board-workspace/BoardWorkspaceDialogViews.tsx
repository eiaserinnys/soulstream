import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel, DialogFooter } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
/** The production board forms; only their data/actions are supplied by the caller. */
export function BoardRenameDialog({
  kind,
  value,
  error,
  onChange,
  onClose,
  onSubmit,
}: {
  kind: "markdown" | "folder" | "frame";
  value: string;
  error?: string;
  onChange(value: string): void;
  onClose(): void;
  onSubmit(): void;
}) {
  const id = `board-${kind}-rename-input`;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-[6px] backdrop-saturate-[1.2]"
      role="dialog"
      aria-label="보드 이름 변경"
    >
      <form
        className="w-80 rounded-md border border-glass-border glass-strong glass-shadow-lg p-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label className="mb-2 block text-sm font-medium" htmlFor={id}>
          {kind === "markdown" ? "문서 이름" : kind === "folder" ? "폴더 이름" : "프레임 이름"}
        </label>
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="mb-3 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
          autoFocus
        />
        {error ? <p className="mb-3 text-xs text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button type="submit" disabled={kind === "markdown" ? undefined : !value.trim()}>
            변경
          </Button>
        </div>
      </form>
    </div>
  );
}

export function BoardMoveDialog({
  open,
  pending,
  error,
  targets,
  selectedFolderId,
  onSelect,
  onMove,
  onClose,
}: {
  open: boolean;
  pending: boolean;
  error: string | null;
  targets: readonly { id: string; title: string }[];
  selectedFolderId: string;
  onSelect(id: string): void;
  onMove(id: string): void;
  onClose(): void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="max-w-sm">
        {" "}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (selectedFolderId) onMove(selectedFolderId);
          }}
        >
          <DialogHeader>
            <DialogTitle>다른 폴더로 이동</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div id="board-task-move-target" className="flex max-h-64 flex-col gap-1 overflow-auto">
              {targets.length > 0 ? (
                targets.map((target) => (
                  <button
                    key={target.id}
                    type="button"
                    disabled={pending}
                    className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                      selectedFolderId === target.id ? "bg-primary text-primary-foreground" : "hover:bg-accent"
                    }`}
                    onClick={() => onSelect(target.id)}
                  >
                    {target.title}
                  </button>
                ))
              ) : (
                <p className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
                  이동할 수 있는 폴더가 없습니다.
                </p>
              )}
            </div>
            {error ? (
              <p className="mt-3 text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              취소
            </Button>
            <Button type="submit" disabled={!selectedFolderId || pending}>
              {pending ? "이동 중…" : "이동"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

export function RenameSessionDialog({
  open,
  input,
  onOpenChange,
  onInputChange,
  onSubmit,
}: {
  open: boolean;
  input: string;
  onOpenChange(open: boolean): void;
  onInputChange(value: string): void;
  onSubmit(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>세션 이름 변경</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <DialogPanel>
            <Input
              autoFocus
              placeholder="세션 이름 (비워두면 기본 이름으로 초기화)"
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
            />
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit">변경</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

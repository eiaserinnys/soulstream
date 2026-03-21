/**
 * FolderDialog - 폴더 생성/삭제 다이얼로그
 *
 * 브라우저 기본 prompt()/confirm() 대신 앱 스타일에 맞는 다이얼로그를 제공한다.
 * mode="create": 폴더 이름 입력 → 생성
 * mode="delete": 삭제 확인 메시지 → 삭제
 */

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
  Button,
  Input,
} from "@seosoyoung/soul-ui";

type FolderDialogProps =
  | {
      mode: "create";
      open: boolean;
      onOpenChange: (open: boolean) => void;
      onConfirm: (name: string) => void;
      folderName?: undefined;
    }
  | {
      mode: "delete";
      open: boolean;
      onOpenChange: (open: boolean) => void;
      onConfirm: () => void;
      folderName: string;
    };

export function FolderDialog(props: FolderDialogProps) {
  if (props.mode === "create") {
    return (
      <CreateFolderDialog
        open={props.open}
        onOpenChange={props.onOpenChange}
        onConfirm={props.onConfirm}
      />
    );
  }

  return (
    <DeleteFolderDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      onConfirm={props.onConfirm}
      folderName={props.folderName}
    />
  );
}

function CreateFolderDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) setName("");
  }, [open]);

  const canSubmit = name.trim().length > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (canSubmit) onConfirm(name.trim());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>새 폴더</DialogTitle>
          <DialogDescription>폴더 이름을 입력하세요.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <DialogPanel>
            <Input
              autoFocus
              placeholder="폴더 이름"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              취소
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              만들기
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function DeleteFolderDialog({
  open,
  onOpenChange,
  onConfirm,
  folderName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  folderName: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>폴더 삭제</DialogTitle>
          <DialogDescription>
            &lsquo;{folderName}&rsquo; 폴더를 삭제하시겠습니까? 폴더 안의
            세션은 미분류로 이동합니다.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            삭제
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

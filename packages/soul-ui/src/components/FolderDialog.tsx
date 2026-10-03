/**
 * FolderDialog - 폴더 생성/보관 다이얼로그
 *
 * 브라우저 기본 prompt()/confirm() 대신 앱 스타일에 맞는 다이얼로그를 제공한다.
 * mode="create": 폴더 이름 입력 → 생성
 * mode="archive": 보관 확인 메시지 → 보관
 */

import { useEffect, useRef, useState } from "react";
import { safeErrorDetail } from "../lib/safe-error-detail";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type FolderDialogProps =
  | {
      mode: "create";
      open: boolean;
      onOpenChange: (open: boolean) => void;
      onConfirm: (name: string) => Promise<void> | void;
      folderName?: undefined;
    }
  | {
      mode: "archive";
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
    <ArchiveFolderDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      onConfirm={props.onConfirm}
      folderName={props.folderName}
    />
  );
}

const createSchema = z.object({
  name: z.string().trim().min(1),
});
type CreateFormValues = z.infer<typeof createSchema>;

function CreateFolderDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (name: string) => Promise<void> | void;
}) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { isValid },
  } = useForm<CreateFormValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: "" },
    mode: "onChange",
  });

  useEffect(() => {
    if (open) { reset({ name: "" }); setError(null); }
  }, [open, reset]);

  const onSubmit = async (data: CreateFormValues) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await onConfirm(data.name);
    } catch (err) {
      setError(safeErrorDetail(err instanceof Error ? err.message : String(err)));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  const changeOpen = (next: boolean) => { if (!inFlight.current) onOpenChange(next); };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogPopup className="approved-dialog max-w-sm" closeProps={{ disabled: pending }}>
        <DialogHeader>
          <DialogTitle>새 폴더</DialogTitle>
          <DialogDescription>폴더 이름을 입력하세요.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)}>
          <DialogPanel>
            <Input
              autoFocus
              disabled={pending}
              placeholder="폴더 이름"
              {...register("name")}
            />
            {error && <div className="dialog-error-notice" role="alert">
              <p>폴더를 만들지 못했습니다. 이름과 연결 상태를 확인한 뒤 다시 시도하세요.</p>
              <details><summary>기술 상세</summary><pre>{error}</pre></details>
            </div>}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => changeOpen(false)}
            >
              취소
            </Button>
            <Button type="submit" disabled={!isValid || pending}>
              {pending ? "만드는 중…" : "만들기"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function ArchiveFolderDialog({
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
      <DialogPopup className="approved-dialog max-w-sm">
        <DialogHeader>
          <DialogTitle>폴더 보관</DialogTitle>
          <DialogDescription>
            &lsquo;{folderName}&rsquo; 폴더를 보관하시겠습니까? 내용과 세션은 보존됩니다.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            보관
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

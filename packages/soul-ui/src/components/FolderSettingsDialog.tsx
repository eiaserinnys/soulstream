/**
 * FolderSettingsDialog - 폴더 설정 다이얼로그
 *
 * 폴더별 설정을 편집하는 다이얼로그.
 * 지원하는 설정: 피드에서 제외, 알림에서 제외, 폴더 프롬프트
 */

import { useEffect } from "react";
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
import { useServerStatus } from "../hooks/useServerStatus";
import { AtomNodeSelector } from "./AtomNodeSelector";
import { getInheritedFolderPrompts } from "../board-workspace/folder-prompt-inheritance";
import type { AtomContextNodeSettings, CatalogFolder, FolderSettings } from "../shared/types";

const settingsSchema = z.object({
  excludeFromFeed: z.boolean(),
  excludeFromNotification: z.boolean(),
  folderPrompt: z.string(),
  atomNodeId: z.string(),
  atomNodeTitle: z.string(),
  atomDepth: z.number().min(1).max(5),
  atomTitlesOnly: z.boolean(),
});
type SettingsFormValues = z.infer<typeof settingsSchema>;

export interface FolderSettingsDialogProps {
  folder: CatalogFolder | null;
  folders?: readonly CatalogFolder[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (settings: FolderSettings) => void;
}

export function FolderSettingsDialog({
  folder,
  folders = [],
  open,
  onOpenChange,
  onConfirm,
}: FolderSettingsDialogProps) {
  const { atomEnabled } = useServerStatus();
  const inheritedPrompts = folder
    ? getInheritedFolderPrompts(folders, folder.id)
    : [];

  const { register, handleSubmit, reset, watch, setValue } =
    useForm<SettingsFormValues>({
      resolver: zodResolver(settingsSchema),
      defaultValues: {
        excludeFromFeed: false,
        excludeFromNotification: false,
        folderPrompt: "",
        atomNodeId: "",
        atomNodeTitle: "",
        atomDepth: 3,
        atomTitlesOnly: false,
      },
    });

  useEffect(() => {
    if (open && folder) {
      reset({
        excludeFromFeed: folder.settings?.excludeFromFeed ?? false,
        excludeFromNotification: folder.settings?.excludeFromNotification ?? false,
        folderPrompt: folder.settings?.folderPrompt ?? "",
        atomNodeId: folder.settings?.atomContextNode?.nodeId ?? "",
        atomNodeTitle: folder.settings?.atomContextNode?.nodeTitle ?? "",
        atomDepth: folder.settings?.atomContextNode?.depth ?? 3,
        atomTitlesOnly: folder.settings?.atomContextNode?.titlesOnly ?? false,
      });
    }
  }, [open, folder, reset]);

  const onSubmit = (data: SettingsFormValues) => {
    const atomContextNode: AtomContextNodeSettings | undefined =
      data.atomNodeId.trim()
        ? {
            nodeId: data.atomNodeId.trim(),
            nodeTitle: data.atomNodeTitle || undefined,
            depth: data.atomDepth,
            titlesOnly: data.atomTitlesOnly,
          }
        : undefined;
    onConfirm({
      excludeFromFeed: data.excludeFromFeed,
      excludeFromNotification: data.excludeFromNotification,
      folderPrompt: data.folderPrompt || undefined,
      atomContextNode,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>폴더 설정</DialogTitle>
          <DialogDescription>{folder?.name}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)}>
          <DialogPanel>
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="checkbox"
                {...register("excludeFromFeed")}
                className="h-4 w-4"
              />
              피드에서 제외
            </label>
            <label className="mt-3 flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="checkbox"
                {...register("excludeFromNotification")}
                className="h-4 w-4"
              />
              알림에서 제외
            </label>
            <div className="mt-3 flex flex-col gap-1">
              <label className="text-sm text-[--color-text-secondary]">
                상속(읽기 전용 미리보기)
              </label>
              <div className="max-h-36 overflow-y-auto rounded border border-[--color-border] bg-[--color-surface-1] px-2 py-2 text-xs">
                {inheritedPrompts.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {inheritedPrompts.map((item) => (
                      <div key={item.folderId} className="flex flex-col gap-1">
                        <span className="font-medium text-[--color-text-primary]">
                          {item.folderName}
                        </span>
                        <p className="whitespace-pre-wrap text-[--color-text-secondary]">
                          {item.prompt}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="text-[--color-text-secondary]">상속된 프롬프트 없음</span>
                )}
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-1">
              <label className="text-sm text-[--color-text-secondary]">
                이 폴더의 추가(편집)
              </label>
              <textarea
                {...register("folderPrompt")}
                placeholder="이 폴더에서만 추가할 지시사항을 입력하세요"
                rows={4}
                className="w-full rounded border border-[--color-border] bg-[--color-surface-1] px-2 py-1 text-sm resize-none"
              />
            </div>
            {atomEnabled && (
              <div className="mt-4 flex flex-col gap-2 border-t border-[--color-border] pt-4">
                <p className="text-sm font-medium">atom 트리 주입</p>
                <p className="text-xs text-[--color-text-secondary]">
                  세션 시작 시 지정한 atom 노드의 서브트리가 컨텍스트로 주입됩니다.
                </p>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-[--color-text-secondary]">노드</label>
                  <AtomNodeSelector
                    value={watch("atomNodeId")}
                    selectedTitle={watch("atomNodeTitle")}
                    onChange={(nodeId, title) => {
                      setValue("atomNodeId", nodeId);
                      setValue("atomNodeTitle", title);
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-[--color-text-secondary]">
                    깊이: {watch("atomDepth")}
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={5}
                    {...register("atomDepth", { valueAsNumber: true })}
                    className="w-full"
                  />
                </div>
                <label className="flex items-center gap-2 cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    {...register("atomTitlesOnly")}
                    className="h-4 w-4"
                  />
                  제목만 가져오기
                </label>
              </div>
            )}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              취소
            </Button>
            <Button type="submit">저장</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

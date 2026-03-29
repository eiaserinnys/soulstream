/**
 * FolderSortButton - 폴더 목록 정렬 방식 선택 버튼
 *
 * FolderTree 헤더의 Plus 버튼 왼쪽에 위치하며,
 * 5가지 정렬 옵션을 드롭다운으로 제공한다.
 */

import { ListFilter, Check } from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/menu";
import { useDashboardStore } from "../stores/dashboard-store";
import type { FolderSortMode } from "../stores/dashboard-store";

const SORT_OPTIONS: { value: FolderSortMode; label: string }[] = [
  { value: "name-asc", label: "이름순 (A → Z)" },
  { value: "name-desc", label: "이름순 (Z → A)" },
  { value: "created-desc", label: "생성순 (최신 우선)" },
  { value: "created-asc", label: "생성순 (과거 우선)" },
  { value: "custom", label: "사용자 지정" },
];

export function FolderSortButton() {
  const folderSortMode = useDashboardStore((s) => s.folderSortMode);
  const setFolderSortMode = useDashboardStore((s) => s.setFolderSortMode);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          title="폴더 정렬"
          className={folderSortMode !== "custom" ? "text-primary" : undefined}
        >
          <ListFilter className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SORT_OPTIONS.map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            onClick={() => setFolderSortMode(opt.value)}
            className="flex items-center gap-2"
          >
            <span className="w-4">
              {folderSortMode === opt.value && <Check className="h-3.5 w-3.5" />}
            </span>
            {opt.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

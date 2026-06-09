import { useMemo } from "react";

import { cn } from "../lib/cn";
import { buildFolderTreeOptions } from "../lib/folder-tree-options";
import type { CatalogFolder } from "../shared/types";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "./ui/select";

export interface NewSessionFolderSelectorProps {
  folders: readonly CatalogFolder[];
  selectedFolderId: string | null;
  onFolderChange: (folderId: string | null) => void;
  label?: string;
  placeholder?: string;
}

export function NewSessionFolderSelector({
  folders,
  selectedFolderId,
  onFolderChange,
  label = "Folder",
  placeholder = "Select a folder...",
}: NewSessionFolderSelectorProps) {
  const options = useMemo(() => buildFolderTreeOptions(folders), [folders]);
  const selectedFolder = selectedFolderId
    ? folders.find((folder) => folder.id === selectedFolderId)
    : null;

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <Select
        value={selectedFolderId ?? ""}
        onValueChange={(value) => onFolderChange(value || null)}
      >
        <SelectTrigger>
          <span className={cn("flex-1 truncate", !selectedFolder && "text-muted-foreground/72")}>
            {selectedFolder?.name ?? placeholder}
          </span>
        </SelectTrigger>
        <SelectPopup>
          {options.map(({ folder, depth }) => (
            <SelectItem key={folder.id} value={folder.id}>
              <span
                className="block truncate"
                data-testid={`new-session-folder-option-${folder.id}`}
                style={{ paddingLeft: depth > 0 ? `${depth * 1}rem` : undefined }}
              >
                {folder.name}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

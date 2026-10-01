import { Folder } from "lucide-react";
import { getFolderNamePresentation } from "@seosoyoung/soul-ui/lib/folder-tree-options";

/** Navigation and selection share the icon slot and title start line. */
export function FolderNameRowContent({ name, level, active, disabled, onSelect }: {
  name: string; level: number; active: boolean; disabled?: boolean; onSelect(): void;
}) {
  const { icon, text } = getFolderNamePresentation(name);
  return <>
    <span className="v3-project-tree-icon" aria-hidden="true">{icon ?? <Folder/>}</span>
    <button type="button" className={`v3-project-nav-link${active ? " is-active" : ""}`}
      aria-label={name} aria-level={level} disabled={disabled} onClick={onSelect}>
      <span>{text}</span>
    </button>
  </>;
}

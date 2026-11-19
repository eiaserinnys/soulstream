// 왼쪽 폴더 내비게이션. 운영의 .v3-navigation 유리 패널과 정본 ProjectNavigationTree 를 쓴다.
import { Button } from "@seosoyoung/soul-ui";

import { ProjectNavigationTree } from "../ProjectNavigationTree";
import { catalogFolders } from "./triage-data";

export function FolderNav({ folder, onSelect }: { folder: string | null; onSelect(id: string | null): void }) {
  return (
    <aside
      className="v3-navigation v3-ht-nav glass-strong glass-chrome lg-rim border border-glass-border"
      aria-label="폴더"
      data-testid="v3-ht-folder-nav"
    >
      <div className="v3-navigation-scroll">
        <h2>카드</h2>
        <div className="v3-nav-list">
          <Button
            variant="ghost"
            size="sm"
            className="v3-ht-all-cards"
            aria-pressed={folder === null}
            onClick={() => onSelect(null)}
            data-testid="v3-ht-all-cards"
          >
            전체 카드
          </Button>
        </div>
        <h2>폴더</h2>
        <div className="v3-nav-list">
          <ProjectNavigationTree
            folders={catalogFolders}
            selectedFolderId={folder}
            isExpanded={() => false}
            onToggleExpanded={() => {}}
            onSelect={selected => onSelect(folder === selected.id ? null : selected.id)}
            onContextMenu={() => {}}
            onReorder={async () => {}}
          />
        </div>
      </div>
    </aside>
  );
}

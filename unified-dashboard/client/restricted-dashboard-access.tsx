import type { CatalogState, DashboardAccess } from "@seosoyoung/soul-ui";

export function isRestrictedDashboardAccess(access: DashboardAccess | undefined): boolean {
  return access?.restricted === true;
}

export function getRestrictedEntryFolderId(
  access: DashboardAccess | undefined,
  catalog: CatalogState | null,
): string | null {
  if (!isRestrictedDashboardAccess(access) || !catalog) return null;
  const visibleFolderIds = new Set(catalog.folders.map((folder) => folder.id));
  for (const folderId of access?.allowedFolderIds ?? []) {
    if (visibleFolderIds.has(folderId)) return folderId;
  }
  return catalog.folders[0]?.id ?? null;
}

export function isFolderVisibleInRestrictedCatalog(
  catalog: CatalogState | null,
  folderId: string | null,
): boolean {
  if (!folderId || !catalog) return false;
  return catalog.folders.some((folder) => folder.id === folderId);
}

export function RestrictedNoFoldersView({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="flex h-full items-center justify-center bg-background p-8 text-center">
      <div className="max-w-sm space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">접근 가능한 폴더가 없습니다</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            계정에 연결된 폴더 권한이 비어 있습니다. 관리자에게 설정 확인을 요청하세요.
          </p>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="inline-flex h-9 items-center justify-center rounded-md border border-border px-4 text-sm font-medium text-foreground hover:bg-muted"
        >
          로그아웃
        </button>
      </div>
    </div>
  );
}

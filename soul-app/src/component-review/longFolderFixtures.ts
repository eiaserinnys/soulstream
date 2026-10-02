import type { CatalogFolder } from '../api/types';
import type { PlannerFolder } from '../api/plannerTypes';
import { useSessionStore } from '../store/sessionStore';
import { usePlannerStore } from '../store/plannerStore';
import { createReviewApi, folders, starredFolders } from './fixtures';

export type FolderReviewLength = 'short' | 'long';

/** Public root folders: every row is visible without changing production tree defaults. */
export function createFolderReviewFixture(length: FolderReviewLength) {
  const catalogFolders: CatalogFolder[] = Array.from({ length: length === 'long' ? 100 : 2 }, (_, index) => ({
    ...folders[0], id: `review-folder-${index}`, name: `공개 폴더 ${String(index + 1).padStart(3, '0')}`,
    parentFolderId: null, projectPageId: `review-page-${index}`, sortOrder: index,
  }));
  const starred: PlannerFolder[] = catalogFolders.map((folder) => ({
    ...starredFolders[0], folderId: folder.id, projectPageId: folder.projectPageId,
    page: { ...starredFolders[0].page, id: folder.projectPageId!, title: folder.name },
  }));
  const api = { ...createReviewApi(), getStarredFolders: async () => ({ items: starred, nextCursor: null }) };
  return { catalogFolders, starred, api };
}

/** Operational components consume their existing stores; restore them when this sample leaves. */
export function installFolderReviewScope(fixture: ReturnType<typeof createFolderReviewFixture>) {
  const catalog = useSessionStore.getState().catalog;
  const { starred, loading, error } = usePlannerStore.getState();
  useSessionStore.setState({ catalog: { ...catalog, folders: fixture.catalogFolders } });
  usePlannerStore.setState({ starred: { items: fixture.starred, nextCursor: null }, loading: {}, error: {} });
  return () => {
    useSessionStore.setState({ catalog });
    usePlannerStore.setState({ starred, loading, error });
  };
}

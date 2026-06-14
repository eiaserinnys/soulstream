/**
 * 폴더 CRUD 낙관적 업데이트 (unified-dashboard)
 *
 * soul-ui의 createFolderOperations 팩토리를 사용하여
 * worker/orchestrator 공통 API 경로에 바인딩한다.
 */

import { createFolderOperations, DEFAULT_FOLDER_ID } from "@seosoyoung/soul-ui";

export const {
  createFolder,
  renameFolderOptimistic,
  deleteFolderOptimistic,
  updateFolderSettingsOptimistic,
  reorderFoldersOptimistic,
} = createFolderOperations({
  createUrl: "/api/folders",
  updateUrl: (id) => `/api/folders/${id}`,
  deleteUrl: (id) => `/api/folders/${id}`,
  reorderUrl: "/api/folders/reorder",
  deleteFallbackFolderId: DEFAULT_FOLDER_ID,
});

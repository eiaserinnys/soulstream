/**
 * 폴더 CRUD 낙관적 업데이트 (unified-dashboard)
 *
 * soul-ui의 createFolderOperations 팩토리를 사용하여
 * soul-server API 경로에 바인딩한다.
 */

import { createFolderOperations, SYSTEM_FOLDERS } from "@seosoyoung/soul-ui";

export const { createFolder, renameFolderOptimistic, deleteFolderOptimistic, updateFolderSettingsOptimistic } =
  createFolderOperations({
    createUrl: "/api/catalog/folders",
    updateUrl: (id) => `/api/catalog/folders/${id}`,
    deleteUrl: (id) => `/api/catalog/folders/${id}`,
    deleteFallbackFolderName: SYSTEM_FOLDERS.claude,
  });

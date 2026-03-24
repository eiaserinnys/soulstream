/**
 * Soul Dashboard API Config
 *
 * soul-ui의 CatalogApiConfig 프리셋. soul-dashboard 전용 API 경로와 동작을 정의한다.
 */

import type { CatalogApiConfig } from "@seosoyoung/soul-ui";
import { SYSTEM_FOLDERS } from "@seosoyoung/soul-ui";

export const SOUL_DASHBOARD_API: CatalogApiConfig = {
  folderBasePath: "/api/catalog/folders",
  sessionBatchMovePath: "/api/catalog/sessions/batch",
  sessionBatchMoveMethod: "PUT",
  sessionBatchMoveBody: (ids, folderId) => ({ sessionIds: ids, folderId }),
  singleSessionMovePath: (id) => `/api/catalog/sessions/${id}`,
  deleteFallbackFolderId: (folders, deletedId) => {
    const claudeFolder = folders.find(
      (f) => f.name === SYSTEM_FOLDERS.claude && f.id !== deletedId,
    );
    return claudeFolder?.id ?? folders.find((f) => f.id !== deletedId)?.id ?? null;
  },
};

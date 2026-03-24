/**
 * CatalogApiConfig - 폴더/세션 API 엔드포인트 추상화
 *
 * soul-dashboard와 orchestrator-dashboard는 서로 다른 API 경로와 메서드를 사용한다.
 * 이 인터페이스로 차이를 파라미터화하여 soul-ui의 폴더/세션 조작 로직을 공유한다.
 */

import type { CatalogFolder } from "../shared/types";

export interface CatalogApiConfig {
  /** 폴더 CRUD base path (예: "/api/catalog/folders" 또는 "/api/folders") */
  folderBasePath: string;
  /** 세션 일괄 이동 경로 (예: "/api/catalog/sessions/batch" 또는 "/api/sessions/folder") */
  sessionBatchMovePath: string;
  /** 세션 일괄 이동 HTTP 메서드 */
  sessionBatchMoveMethod: "PUT" | "PATCH";
  /** 세션 일괄 이동 요청 body 생성 */
  sessionBatchMoveBody: (sessionIds: string[], folderId: string | null) => unknown;
  /** 단일 세션 이동 경로 (soul-dashboard only). undefined이면 항상 batch 사용 */
  singleSessionMovePath?: (sessionId: string) => string;
  /** 폴더 삭제 시 fallback 폴더 결정 로직 */
  deleteFallbackFolderId: (folders: CatalogFolder[], deletedFolderId: string) => string | null;
}

/**
 * Soul Dashboard - 카탈로그(폴더) 타입 정의
 *
 * 사용자가 정의한 폴더 구조와 폴더별 설정(폴더 프롬프트, atom 트리 주입 등)을
 * 표현하는 타입. 카탈로그 상태는 세션 목록과 별개로 관리됩니다.
 */

import type { SessionSummary } from "./session-types";

/** atom 트리 주입 설정 */
export interface AtomContextNodeSettings {
  nodeId: string;        // atom 트리 노드 ID
  nodeTitle?: string;    // 저장된 노드 표시 이름 (UUID 대신 이름 표시용)
  depth?: number;        // 컴파일 깊이 (기본 3)
  titlesOnly?: boolean;  // 제목만 가져올지 (기본 false)
}

/** 폴더 설정 */
export interface FolderSettings {
  excludeFromFeed?: boolean;
  excludeFromNotification?: boolean;
  folderPrompt?: string;          // 새 세션 시작 시 컨텍스트에 주입할 지시사항
  atomContextNode?: AtomContextNodeSettings; // atom 트리 주입 설정
}

/** 카탈로그 폴더 */
export interface CatalogFolder {
  id: string;
  name: string;
  sortOrder: number;
  parentFolderId?: string | null;
  settings?: FolderSettings;
  createdAt?: string;
}

/** 폴더 drag/reorder mutation 항목 */
export interface CatalogFolderReorderItem {
  id: string;
  sortOrder: number;
  parentFolderId?: string | null;
}

/** 카탈로그 세션 배치 정보 */
export interface CatalogAssignment {
  folderId: string | null;
  displayName: string | null;
}

export type CatalogBoardItemType =
  | "session"
  | "markdown"
  | "subfolder"
  | "asset"
  | "frame"
  | "runbook";

export interface CatalogBoardItem {
  id: string;
  folderId: string;
  itemType: CatalogBoardItemType;
  itemId: string;
  x: number;
  y: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface MarkdownDocument {
  id: string;
  title: string;
  body: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

/** 카탈로그 상태 */
export interface CatalogState {
  folders: CatalogFolder[];
  sessions: Record<string, CatalogAssignment>;
  boardItems?: CatalogBoardItem[];
  sessionList?: SessionSummary[];
}

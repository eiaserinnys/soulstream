import { z } from "zod";
import { callerSessionIdSchema, expectedVersionSchema, idempotencyKeySchema, mutationToolDescription } from "./folder_shared.js";

export const FOLDER_SEARCH_SCAN_LIMIT = 2_000;

export const boardTools = {
  list_folders: { name: "list_folders", config: { description: "전체 폴더 목록.", inputSchema: {} }, audience: "all" },
  browse_folder: { name: "browse_folder", config: {
      description:
        "폴더 내부를 한 번에 브라우즈한다. 직접 자식 폴더, 세션 페이지, 문서/이미지/파일 보드 항목을 함께 반환.",
      inputSchema: {
        folder_id: z.string().min(1),
        session_cursor: z.number().int().min(0).default(0),
        session_limit: z.number().int().min(1).max(100).default(20),
        cursor: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        include_archived: z.boolean().default(false),
      },
    }, audience: "all" },
  move_folder: { name: "move_folder", config: {
      description: "폴더를 다른 부모 폴더 아래로 이동. parent_folder_id=null/미지정 → 루트로 이동.",
      inputSchema: {
        folder_id: z.string(),
        parent_folder_id: z.string().nullable().optional(),
      },
    }, audience: "all" },
  delete_folder: { name: "delete_folder", config: {
      description: "폴더 삭제.",
      inputSchema: { folder_id: z.string() },
    }, audience: "internal" },
  move_sessions_to_folder: { name: "move_sessions_to_folder", config: {
      description: "세션들을 폴더로 이동. folder_id=null/미지정 → 폴더 해제.",
      inputSchema: {
        session_ids: z.array(z.string().min(1)),
        folder_id: z.string().optional(),
      },
    }, audience: "all" },
  update_board_item_position: { name: "update_board_item_position", config: {
      description: "보드 항목 좌표 갱신. 좌표는 서버에서 20px 격자에 스냅된다.",
      inputSchema: {
        board_item_id: z.string().min(1),
        x: z.number(),
        y: z.number(),
      },
    }, audience: "all" },
  move_board_item_to_folder: { name: "move_board_item_to_folder", config: {
      description:
        "기존 보드 항목을 다른 폴더로 이동한다.",
      inputSchema: {
        board_item_id: z.string().min(1),
        folder_id: z.string().min(1),
        x: z.number().optional(),
        y: z.number().optional(),
        idempotency_key: z.string().min(1),
      },
    }, audience: "all" },
  create_markdown_document: { name: "create_markdown_document", config: {
      description: "현재 보드 폴더에 마크다운 문서와 보드 카드를 생성.",
      inputSchema: {
        folder_id: z.string().min(1),
        title: z.string().min(1),
        body: z.string().default(""),
        x: z.number().optional(),
        y: z.number().optional(),
      },
    }, audience: "all" },
  get_markdown_document: { name: "get_markdown_document", config: {
      description: "마크다운 문서 본문 조회.",
      inputSchema: { document_id: z.string().min(1) },
    }, audience: "all" },
  update_markdown_document: { name: "update_markdown_document", config: {
      description: "마크다운 문서 제목 또는 본문 수정.",
      inputSchema: {
        document_id: z.string().min(1),
        expected_version: z.number().int().positive(),
        title: z.string().optional(),
        body: z.string().optional(),
      },
    }, audience: "all" },
  delete_markdown_document: { name: "delete_markdown_document", config: {
      description: "마크다운 문서와 해당 보드 카드를 삭제.",
      inputSchema: { document_id: z.string().min(1) },
    }, audience: "internal" },
  get_folder_system_prompt: { name: "get_folder_system_prompt", config: {
      description: "폴더 시스템 프롬프트 조회.",
      inputSchema: { folder_id: z.string() },
    }, audience: "all" },
  set_folder_system_prompt: { name: "set_folder_system_prompt", config: {
      description: "폴더 시스템 프롬프트 설정. 빈 문자열·null → 삭제.",
      inputSchema: {
        folder_id: z.string(),
        system_prompt: z.string().optional(),
      },
    }, audience: "internal" },
  search_folder_items: { name: "search_folder_items", config: {
    description: `한 폴더 안에서 최근 갱신된 최대 ${FOLDER_SEARCH_SCAN_LIMIT}개 세션과 마크다운의 표시명·제목·본문을 검색한다. truncated=true면 더 오래된 항목은 검색되지 않았다.`,
    inputSchema: {
      folder_id: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().positive().default(20),
      include_archived: z.boolean().default(false),
    },
  }, audience: "all" },
  create_custom_view: { name: "create_custom_view", config: {
      description: mutationToolDescription(
        "현재 MCP caller origin을 감사 actor로 하여 sandboxed HTML custom view board item을 생성한다.",
      ),
      inputSchema: {
        folder_id: z.string().min(1),
        title: z.string().default("Custom view"),
        html: z.string(),
        x: z.number().optional(),
        y: z.number().optional(),
        idempotency_key: idempotencyKeySchema,
        caller_session_id: callerSessionIdSchema,
      },
    }, audience: "all" },
  patch_custom_view: { name: "patch_custom_view", config: {
      description: mutationToolDescription(
        "커스텀 뷰 HTML을 전체 replace로 갱신한다. expected_revision이 맞지 않으면 충돌로 실패한다.",
      ),
      inputSchema: {
        custom_view_id: z.string().min(1),
        expected_revision: expectedVersionSchema,
        html: z.string(),
        title: z.string().nullable().optional(),
        idempotency_key: idempotencyKeySchema,
        caller_session_id: callerSessionIdSchema,
      },
    }, audience: "all" },
  get_custom_view: { name: "get_custom_view", config: {
      description: "커스텀 뷰 HTML과 revision을 조회한다.",
      inputSchema: { custom_view_id: z.string().min(1) },
    }, audience: "all" },
  list_custom_views: { name: "list_custom_views", config: {
      description: "지정한 폴더의 커스텀 뷰 목록을 조회한다.",
      inputSchema: {
        folder_id: z.string().min(1),
        include_archived: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
      },
    }, audience: "all" },
} as const;

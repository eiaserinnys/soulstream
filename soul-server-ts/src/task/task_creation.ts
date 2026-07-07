import type { Logger } from "pino";

import type { BoardYjsService } from "../collaboration/board_yjs_service.js";
import type { ContextItem } from "../context/prompt_assembler.js";
import type { BoardYjsContainerRef, CatalogBoardItemRow, SessionDB } from "../db/session_db.js";
import type { ClaudePermissionMode, ReasoningEffort } from "../engine/protocol.js";
import { defaultFolderIdForSessionType } from "../system_folders.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type {
  CallerInfo,
  SessionType,
  Task,
} from "./task_models.js";
import {
  buildCallerInfoMetadataEntry,
  buildClaudePermissionModeMetadataEntry,
} from "./task_metadata.js";

export interface CreateTaskParams {
  agentSessionId: string;
  prompt: string;
  profileId?: string;
  clientId?: string | null;
  sessionType?: SessionType;
  llmProvider?: string | null;
  llmModel?: string | null;
  llmUsage?: Record<string, number> | null;
  callerSessionId?: string | null;
  callerInfo?: CallerInfo;
  model?: string | null;
  oauthToken?: string;
  reasoningEffort?: ReasoningEffort;
  /** 요청별 허용 도구 override. 없으면 AgentProfile.allowed_tools 사용. */
  allowedTools?: string[];
  /** 요청별 금지 도구 override. 없으면 AgentProfile.disallowed_tools 사용. */
  disallowedTools?: string[];
  /** 요청별 MCP 사용 여부. undefined면 true. */
  useMcp?: boolean;
  /** 요청별 Claude Agent SDK permission mode override. */
  claudePermissionMode?: ClaudePermissionMode;
  folderId?: string | null;
  container?: BoardYjsContainerRef | null;
  sourceRunbookItemId?: string | null;
  /** B-6 context_builder: 사용자/위임자 system_prompt. folder_prompt와 합성됨. */
  systemPrompt?: string;
  /** 첫 turn prompt와 user_message.context에 함께 박을 외부 context items. */
  contextItems?: ContextItem[];
  /** 첫 turn user_message.attachments와 engine image 입력 분리에 사용할 원본 첨부 경로. */
  attachmentPaths?: string[];
}

export interface TaskCreationDeps {
  nodeId: string;
  db: SessionDB;
  boardYjsService?: Pick<BoardYjsService, "upsertSessionBoardItem">;
  broadcaster: SessionBroadcaster;
  logger: Logger;
  hasTask(sessionId: string): boolean;
  rememberTask(task: Task): void;
}

/**
 * Owns new runtime task creation.
 *
 * This is the only place that assembles the initial Task shape, DB
 * `session_register` payload, caller metadata timing, folder assignment, and
 * `session_created` broadcast ordering for a brand-new session.
 */
export class TaskCreation {
  constructor(private readonly deps: TaskCreationDeps) {}

  /**
   * 새 Task 생성 + DB 등록 + orch broadcast.
   *
   * 같은 agentSessionId가 이미 있으면 throw — 중복 차단.
   * DB register 실패 시 in-memory map에 task를 *남기지 않음* (실패 격리).
   */
  async createTask(params: CreateTaskParams): Promise<Task> {
    if (this.deps.hasTask(params.agentSessionId)) {
      throw new Error(`Task already exists: ${params.agentSessionId}`);
    }
    if (params.container?.containerKind === "runbook" && !this.deps.boardYjsService) {
      throw new Error("Board Yjs service is required for runbook session placement");
    }

    const now = new Date();
    const callerMetadata = buildCallerInfoMetadataEntry(params.callerInfo);
    const permissionModeMetadata = buildClaudePermissionModeMetadataEntry(params.claudePermissionMode);
    const metadata = [callerMetadata, permissionModeMetadata].filter(
      (entry): entry is Record<string, unknown> => entry !== undefined,
    );
    const sessionType = params.sessionType ?? "claude";
    const task: Task = {
      agentSessionId: params.agentSessionId,
      prompt: params.prompt,
      status: "running",
      profileId: params.profileId,
      clientId: params.clientId ?? null,
      sessionType,
      llmProvider: params.llmProvider ?? null,
      llmModel: params.llmModel ?? null,
      llmUsage: params.llmUsage ?? null,
      callerSessionId: params.callerSessionId ?? undefined,
      callerInfo: params.callerInfo,
      metadata,
      model: params.model,
      oauthToken: params.oauthToken,
      reasoningEffort: params.reasoningEffort,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      useMcp: params.useMcp,
      claudePermissionMode: params.claudePermissionMode,
      systemPrompt: params.systemPrompt,
      contextItems: params.contextItems,
      attachmentPaths: params.attachmentPaths,
      createdAt: now,
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    };

    // DB 등록 — schema.sql session_register는 *INSERT only*, ON CONFLICT 없음.
    // 같은 session_id 중복 INSERT 시 PK violation throw → 호출자에게 신호.
    await this.deps.db.registerSession({
      sessionId: task.agentSessionId,
      nodeId: this.deps.nodeId,
      agentId: task.profileId ?? null,
      claudeSessionId: null,
      sessionType,
      prompt: task.prompt,
      clientId: task.clientId ?? null,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.createdAt,
      callerSessionId: task.callerSessionId ?? null,
    });

    // caller_info와 session-scoped SDK policy를 Task.metadata와 DB에 동시 저장. Python TaskFactory와 같은 타이밍:
    // session_created 전에 박아 feed/folder 초기 카드가 metadata fallback을 즉시 사용할 수 있게 한다.
    for (const entry of metadata) {
      await this.deps.db.appendMetadata(task.agentSessionId, entry);
    }

    this.deps.rememberTask(task);

    // 폴더 배정 + catalog_updated broadcast (Python `task_manager.py:284-323`
    // `_assign_default_folder_and_broadcast` 정본). codex 세션이 dashboard 폴더 트리에서
    // 보이지 않던 결함의 정본 fix — session_register는 folder_id를 받지 않으므로 *별도*
    // session_assign_folder로 박는다. folder_id 미지정 시 session_type 기반 기본 폴더 폴백.
    //
    // 부가 기능 — 실패는 격리 (Python L292-293 코멘트 정합).
    const assignedFolderId = await this.assignFolderAndBroadcastCatalog(
      task.agentSessionId,
      sessionType,
      params.folderId ?? null,
      params.container ?? null,
      params.sourceRunbookItemId ?? null,
    );

    // broadcast session_created — 실패해도 task는 메모리에 살아있음 (orch 재연결 시 동기 가능).
    // Python L304-313 정합: catalog_updated 이후 session_created 발행 (순서 보장).
    try {
      await this.deps.broadcaster.emitSessionCreated(task, assignedFolderId);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "session_created broadcast failed",
      );
    }

    return task;
  }

  /**
   * 신규 세션을 폴더에 배정 + catalog_updated wire broadcast.
   *
   * Python `service/task_manager.py:284-323 _assign_default_folder_and_broadcast` 정본 이식.
   *   - folder_id 명시 → 그 폴더에 배정
   *   - 미지정 → sessionType에 대응하는 기본 폴더 id lookup → 배정
   *   - 기본 폴더 미존재 → 폴더 배정 없음(graceful) + broadcast 없음
   *   - 폴더 배정 후 `getCatalog` + `emitCatalogUpdated` (dashboard 폴더 트리 즉시 갱신)
   *
   * 부가 기능 — 각 단계 실패를 격리 (Python L292-293 "폴더 배정이나 브로드캐스트에 실패해도
   * 호출자의 핵심 동작(세션 생성/등록)에 영향을 주지 않는다").
   *
   * 반환: 최종 배정된 folder_id. 배정 안 됐으면 null.
   */
  private async assignFolderAndBroadcastCatalog(
    sessionId: string,
    sessionType: string,
    folderId: string | null,
    container: BoardYjsContainerRef | null,
    sourceRunbookItemId: string | null,
  ): Promise<string | null> {
    let assigned: string | null = null;
    try {
      if (container?.containerKind === "runbook") {
        const scope = await this.deps.db.resolveBoardYjsContainerScope(container);
        if (!scope) {
          throw new Error(`board container not found: ${container.containerKind}:${container.containerId}`);
        }
        await this.deps.db.assignSessionToFolder(sessionId, scope.folderId);
        assigned = scope.folderId;
        const [x, y] = await this.nextRunbookSessionPosition(container);
        await this.deps.boardYjsService?.upsertSessionBoardItem({
          folderId: scope.folderId,
          container,
          sessionId,
          sourceRunbookItemId,
          x,
          y,
        });
      } else if (folderId !== null) {
        await this.deps.db.assignSessionToFolder(sessionId, folderId);
        assigned = folderId;
      } else {
        const defaultFolderId = defaultFolderIdForSessionType(sessionType);
        const folder = await this.deps.db.getFolderById(defaultFolderId);
        if (folder) {
          await this.deps.db.assignSessionToFolder(sessionId, folder.id);
          assigned = folder.id;
        }
      }
    } catch (err) {
      this.deps.logger.warn(
        {
          err,
          sessionId,
          requestedFolderId: folderId,
          assignedFolderId: assigned,
          targetContainer: container
            ? { containerKind: container.containerKind, containerId: container.containerId }
            : null,
          sourceRunbookItemId,
        },
        "session folder assignment or board container enrollment failed - proceeding with folder fallback",
      );
    }

    if (assigned !== null) {
      try {
        const catalog = await this.deps.db.getCatalog();
        await this.deps.broadcaster.emitCatalogUpdated(catalog);
      } catch (err) {
        this.deps.logger.warn(
          { err, sessionId },
          "catalog_updated broadcast failed",
        );
      }
    }

    return assigned;
  }

  private async nextRunbookSessionPosition(container: BoardYjsContainerRef): Promise<[number, number]> {
    const seed = await this.deps.db.loadBoardYjsSeed(container);
    const occupied = new Set(seed.boardItems.map((item: CatalogBoardItemRow) => `${item.x}:${item.y}`));
    let index = 4;
    while (true) {
      const x = (index % 4) * 280;
      const y = Math.floor(index / 4) * 160;
      if (!occupied.has(`${x}:${y}`)) return [x, y];
      index += 1;
    }
  }
}

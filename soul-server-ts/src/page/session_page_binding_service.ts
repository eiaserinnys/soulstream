import type { Logger } from "pino";
import { projectSessionBindingWarnings } from "@soulstream/page-model";

import type { BoardYjsService } from "../collaboration/board_yjs_service.js";
import type { BoardYjsContainerRef, SessionDB } from "../db/session_db.js";
import { defaultFolderIdForSessionType } from "../system_folders.js";
import {
  appendCreationWarning,
  type LegacyProjectionHookParams,
  type TaskCreationHook,
  type TaskCreationHookParams,
} from "../task/task_creation_hook.js";
import { sessionBoardItemPosition } from "../task/task_session_position.js";
import type { PageYjsHostClient } from "./page_host_client.js";
import { decideSessionPageEnrollment } from "./session_page_enrollment_policy.js";
import {
  SessionPageBindingRepository,
  type SessionPageBindingRow,
} from "./session_page_binding_repository.js";

interface PageBindingPort {
  getPage: PageYjsHostClient["getPage"];
  getDailyPage: PageYjsHostClient["getDailyPage"];
  batchPageOperations: PageYjsHostClient["batchPageOperations"];
}

interface LegacyProjectionPort {
  project(binding: SessionPageBindingRow): Promise<void>;
}

export interface SessionPageBindingServiceDeps {
  nodeId: string;
  repository: SessionPageBindingRepository;
  pageHost: PageBindingPort;
  legacyProjection: LegacyProjectionPort;
  logger: Pick<Logger, "warn" | "info">;
  now?: () => Date;
  operationTimeoutMs?: number;
}

/** Durable creation hook and owner-node replay loop for canonical session page binding. */
export class SessionPageBindingService implements TaskCreationHook {
  private timer: NodeJS.Timeout | undefined;
  private reconciling = false;
  private readonly sessionTails = new Map<string, Promise<void>>();

  constructor(private readonly deps: SessionPageBindingServiceDeps) {}

  async afterSessionRegistered({ task, params }: TaskCreationHookParams): Promise<void> {
    const enrollment = decideSessionPageEnrollment({
      hasPageAnchor: params.pageAnchor !== undefined,
      containerKind: params.container?.containerKind ?? null,
      callerSource: params.callerInfo?.source,
    });
    await this.deps.repository.enqueue({
      sessionId: task.agentSessionId,
      nodeId: this.deps.nodeId,
      targetPageId: params.pageAnchor?.pageId ?? null,
      targetBlockId: params.pageAnchor?.blockId ?? null,
      targetExpectedVersion: params.pageAnchor?.expectedVersion ?? null,
      initialPageState: enrollment.kind === "excluded" ? "bound" : "pending",
      dailyDate: kstDate(this.deps.now?.() ?? new Date()),
      sessionType: params.sessionType ?? "claude",
      legacyFolderId: params.folderId ?? null,
      legacyContainerKind: params.container?.containerKind ?? null,
      legacyContainerId: params.container?.containerId ?? null,
      sourceTaskItemId: params.sourceTaskItemId ?? null,
    });
    await this.reconcileSession(task.agentSessionId, true);
    const binding = await this.deps.repository.get(task.agentSessionId);
    for (const warning of projectSessionBindingWarnings({
      pageState: binding?.page_state,
      legacyState: "completed",
    })) {
      appendCreationWarning(task, warning);
    }
  }

  async afterLegacyProjection(params: LegacyProjectionHookParams): Promise<void> {
    await this.withSessionLock(params.task.agentSessionId, async () => {
      const binding = await this.deps.repository.get(params.task.agentSessionId);
      if (!binding || binding.legacy_state !== "pending") return;
      if (params.completed) {
        await this.deps.repository.markLegacyCompleted(params.task.agentSessionId);
        return;
      }
      await this.deps.repository.markFailure(
        params.task.agentSessionId,
        "legacy",
        "legacy folder/board projection failed during task creation",
        false,
      );
    });
    const binding = await this.deps.repository.get(params.task.agentSessionId);
    for (const warning of projectSessionBindingWarnings({
      pageState: "bound",
      legacyState: binding?.legacy_state,
    })) {
      appendCreationWarning(params.task, warning);
    }
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    void this.reconcileDue();
    this.timer = setInterval(() => void this.reconcileDue(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async reconcileDue(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const due = await this.deps.repository.listDue(this.deps.nodeId);
      await Promise.all(due.map((binding) => this.reconcileSession(binding.session_id, false, true)));
    } catch (err) {
      this.deps.logger.warn({ err }, "session page binding reconciliation scan failed");
    } finally {
      this.reconciling = false;
    }
  }

  async reconcile(binding: SessionPageBindingRow, pageOnly = false): Promise<void> {
    await this.reconcileSession(binding.session_id, pageOnly);
  }

  private async reconcileSession(
    sessionId: string,
    pageOnly: boolean,
    requireDue = false,
  ): Promise<void> {
    await this.withSessionLock(sessionId, async () => {
      const binding = await this.deps.repository.get(sessionId);
      if (!binding) return;
      if (requireDue && binding.next_retry_at.getTime() > (this.deps.now?.() ?? new Date()).getTime()) {
        return;
      }
      await this.reconcileLatest(binding, pageOnly);
    });
  }

  private async reconcileLatest(binding: SessionPageBindingRow, pageOnly: boolean): Promise<void> {
    if (binding.page_state === "pending") {
      try {
        await this.withTimeout(this.bindPrimaryPage(binding), "primary page binding");
        await this.deps.repository.markPageBound(binding.session_id);
        binding = { ...binding, page_state: "bound" };
      } catch (err) {
        await this.recordFailure(binding, "page", err);
        return;
      }
    }
    if (pageOnly || binding.page_state !== "bound" || binding.legacy_state !== "pending") return;
    try {
      await this.withTimeout(this.deps.legacyProjection.project(binding), "legacy projection");
      await this.deps.repository.markLegacyCompleted(binding.session_id);
    } catch (err) {
      await this.recordFailure(binding, "legacy", err);
    }
  }

  private async bindPrimaryPage(binding: SessionPageBindingRow): Promise<void> {
    if (binding.target_page_id && binding.target_block_id && binding.target_expected_version) {
      const target = await this.deps.pageHost.getPage(binding.target_page_id, true);
      if (!target.blocks?.some((block) => block.id === binding.target_block_id)) {
        throw new ManualRepairError(`stale page anchor block: ${binding.target_block_id}`);
      }
      await this.deps.pageHost.batchPageOperations({
        page_id: binding.target_page_id,
        expected_version: binding.target_expected_version,
        operations: [{
          op: "update_block_type_and_properties",
          block_id: binding.target_block_id,
          block_type: "session_ref",
          properties: { sessionId: binding.session_id, primary: true },
        }],
        actor_session_id: binding.session_id,
        idempotency_key: `session-page-binding:${binding.session_id}:primary`,
      });
      return;
    }
    const daily = await this.deps.pageHost.getDailyPage({
      date: binding.daily_date,
      actorSessionId: binding.session_id,
    });
    await this.deps.pageHost.batchPageOperations({
      page_id: daily.page.id,
      expected_version: daily.page.version,
      operations: [{
        op: "create_block",
        temp_id: `session-ref-${binding.session_id}`,
        parent_id: null,
        after_block_id: null,
        block_type: "session_ref",
        text: `[[${daily.page.title}]]`,
        properties: { sessionId: binding.session_id, primary: true },
      }],
      actor_session_id: binding.session_id,
      idempotency_key: `session-page-binding:${binding.session_id}:primary`,
    });
  }

  private async recordFailure(
    binding: SessionPageBindingRow,
    step: "page" | "legacy",
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const conflict = /\b409\b|conflict/i.test(message);
    const dailyCasRace = step === "page" && binding.target_page_id === null && conflict;
    const manualRepair = err instanceof ManualRepairError
      || /\b(401|403|404)\b|unauthori[sz]ed|forbidden|not found|stale|permission/i.test(message)
      || (conflict && !dailyCasRace);
    await this.deps.repository.markFailure(binding.session_id, step, message, manualRepair);
    this.deps.logger.warn(
      { err, sessionId: binding.session_id, step, manualRepair },
      "session page binding step failed; durable state retained",
    );
  }

  private async withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate, () => gate);
    this.sessionTails.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
      if (this.sessionTails.get(sessionId) === tail) this.sessionTails.delete(sessionId);
    }
  }

  private async withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    const timeoutMs = this.deps.operationTimeoutMs ?? 5_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export class SessionLegacyProjection implements LegacyProjectionPort {
  constructor(
    private readonly db: SessionDB,
    private readonly boardYjsService: Pick<BoardYjsService, "upsertSessionBoardItem">,
  ) {}

  async project(binding: SessionPageBindingRow): Promise<void> {
    if (binding.legacy_container_kind && binding.legacy_container_id) {
      const container: BoardYjsContainerRef = {
        containerKind: binding.legacy_container_kind as BoardYjsContainerRef["containerKind"],
        containerId: binding.legacy_container_id,
      };
      const scope = await this.db.resolveBoardYjsContainerScope(container);
      if (!scope) throw new ManualRepairError(`stale legacy container: ${binding.legacy_container_id}`);
      await this.db.assignSessionToFolder(binding.session_id, scope.folderId);
      const seed = await this.db.loadBoardYjsSeed(container);
      const [x, y] = sessionBoardItemPosition(seed.boardItems, binding.session_id);
      await this.boardYjsService.upsertSessionBoardItem({
        folderId: scope.folderId,
        container,
        sessionId: binding.session_id,
        sourceTaskItemId: binding.source_task_item_id,
        x,
        y,
      });
      return;
    }
    if (binding.legacy_folder_id) {
      if (!await this.db.getFolderById(binding.legacy_folder_id)) {
        throw new ManualRepairError(`stale legacy folder: ${binding.legacy_folder_id}`);
      }
      await this.db.assignSessionToFolder(binding.session_id, binding.legacy_folder_id);
      return;
    }
    const folderId = defaultFolderIdForSessionType(binding.session_type);
    if (await this.db.getFolderById(folderId)) {
      await this.db.assignSessionToFolder(binding.session_id, folderId);
    }
  }
}

class ManualRepairError extends Error {}

export function kstDate(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

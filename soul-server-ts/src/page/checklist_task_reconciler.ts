import type { Logger } from "pino";

import type { ChecklistBlockProperties, ChecklistTaskReference } from "@soulstream/page-model";

import type { PageYjsHostClient } from "./page_host_client.js";
import type { ChecklistTaskAdapter } from "./checklist_task_adapter.js";
import type {
  ChecklistProjectionOutboxRow,
  ChecklistTaskProjectionRepository,
} from "./checklist_task_projection_repository.js";

export type { ChecklistProjectionOutboxRow } from "./checklist_task_projection_repository.js";

interface ChecklistProjectionRepositoryPort {
  claimDue: ChecklistTaskProjectionRepository["claimDue"];
  markSuccess: ChecklistTaskProjectionRepository["markSuccess"];
  markFailure: ChecklistTaskProjectionRepository["markFailure"];
}

interface ChecklistProjectionAdapterPort {
  reconcile: ChecklistTaskAdapter["reconcile"];
  archive: ChecklistTaskAdapter["archive"];
}

interface ChecklistProjectionPageHostPort {
  getPage: PageYjsHostClient["getPage"];
  batchPageOperations: PageYjsHostClient["batchPageOperations"];
}

export interface ChecklistTaskReconcilerDeps {
  nodeId: string;
  repository: ChecklistProjectionRepositoryPort;
  adapter: ChecklistProjectionAdapterPort;
  pageHost: ChecklistProjectionPageHostPort;
  logger: Pick<Logger, "warn" | "info">;
}

/** Restart-safe scanner. The outbox, not this timer, owns pending projection state. */
export class ChecklistTaskReconciler {
  private timer: NodeJS.Timeout | undefined;
  private reconciling = false;

  constructor(private readonly deps: ChecklistTaskReconcilerDeps) {}

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
      const rows = await this.deps.repository.claimDue(this.deps.nodeId);
      await Promise.all(rows.map((row) => this.reconcileRow(row)));
    } catch (error) {
      this.deps.logger.warn({ err: error }, "checklist Task projection scan failed");
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileRow(row: ChecklistProjectionOutboxRow): Promise<void> {
    try {
      const current = await this.deps.pageHost.getPage(row.page_id, true);
      const block = current.blocks?.find((candidate) => candidate.id === row.block_id);
      const actor = projectionActor(row);
      if (!block || block.block_type !== "checklist") {
        await this.deps.adapter.archive({
          pageId: row.page_id,
          blockId: row.block_id,
          actor,
        });
      } else {
        const projected = await this.deps.adapter.reconcile({
          page: {
            id: current.page.id,
            title: current.page.title,
            metadata: current.page.metadata,
          },
          block: {
            id: block.id,
            text: block.text,
            properties: block.properties as ChecklistBlockProperties,
          },
          actor,
        });
        if (!isExactReference(block.properties, projected.properties)) {
          await this.deps.pageHost.batchPageOperations({
            page_id: row.page_id,
            expected_version: current.page.version,
            operations: [{
              op: "update_block_type_and_properties",
              block_id: row.block_id,
              block_type: "checklist",
              properties: projected.properties,
            }],
            actor_session_id: row.routing_session_id,
            idempotency_key: `checklist-projection:${row.block_id}:${row.source_hash}`,
          });
        }
      }
      await this.deps.repository.markSuccess(row, this.deps.nodeId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.repository.markFailure(row, this.deps.nodeId, message);
      this.deps.logger.warn(
        { err: error, pageId: row.page_id, blockId: row.block_id },
        "checklist Task projection retained for retry",
      );
    }
  }
}

function projectionActor(row: ChecklistProjectionOutboxRow) {
  return {
    actorKind: row.actor_kind,
    actorSessionId: row.routing_session_id,
    ...(row.actor_kind === "user" ? { actorUserId: row.actor_user_id } : {}),
  };
}

function isExactReference(
  properties: Record<string, unknown>,
  reference: ChecklistTaskReference,
): boolean {
  const keys = Object.keys(properties).sort();
  return keys.length === 2
    && keys[0] === "itemId"
    && keys[1] === "taskId"
    && properties.taskId === reference.taskId
    && properties.itemId === reference.itemId;
}

import { randomUUID } from "node:crypto";
import { buildCanonicalDeliveryPayload } from "@soulstream/wire-schema/delivery";
import type { SessionDeliveryRow } from "../control_plane/control_plane_types.js";
import { registerSessionDelivery } from "../control_plane/repositories/session_delivery_relation_repository.js";
import type { CardControlPlaneService } from "./card_control_plane_service.js";
import { buildCardChangeNotification } from "./card_change_notification.js";
import type { CardExecutionService, CardExecutionRequest } from "./card_execution_service.js";
import type { CardRow, FolderOperationRow, RepositorySql, SqlClient } from "./control_plane/card_types.js";

export type DispatchWorkInput = {
  request: string;
  brief?: string;
  idempotencyKey: string;
} & (
  | { kind: "create"; title: string; folderId?: string; agentId?: string; modelPreset?: string; nodeId?: string }
  | { kind: "followup"; cardId: string }
);

export type DispatchWorkActor = {
  actorKind: "agent";
  actorSessionId: string;
};

export type AcceptedWork = {
  accepted: true;
  idempotent: boolean;
  operationId: string;
  card: { id: string; number: number | null };
  work:
    | { kind: "execution"; requestId: string; sessionId: string }
    | { kind: "delivery"; deliveryId: string; sessionId: string };
};

export interface CardWorkDispatchServiceOptions {
  sql: SqlClient;
  cards: Pick<CardControlPlaneService, "createCardTx" | "addCommentTx" | "markCommentDelivered" | "mcpRead">;
  execution: Pick<CardExecutionService, "reserveTx" | "startReserved">;
  authorizeFolder(folderId: string, actor: DispatchWorkActor): Promise<void>;
  sendDelivery(row: SessionDeliveryRow): Promise<void>;
  emitCardUpdated(cardId: string, folderId: string): void | Promise<void>;
  warn(message: string): void;
}

type CallerSessionDefaults = {
  folder_id: string | null;
  agent_id: string | null;
  node_id: string | null;
  model_preset: string | null;
};

type StoredOperation = FolderOperationRow & {
  payload_json: Record<string, unknown>;
};

type DeliveryQueryRow = SessionDeliveryRow & Record<string, unknown>;
type NewlyAcceptedWork = { receipt: AcceptedWork; folderId: string };

const systemFolders = new Set(["claude", "llm"]);

export class CardWorkDispatchService {
  constructor(private readonly options: CardWorkDispatchServiceOptions) {}

  async accept(input: DispatchWorkInput, actor: DispatchWorkActor): Promise<AcceptedWork> {
    assertInput(input, actor);
    const idempotencyKey = `dispatch-work:${actor.actorSessionId}:${input.idempotencyKey}`;
    let preflightFolderId: string | null = null;
    if (input.kind === "followup") {
      const existing = await this.options.cards.mcpRead.getCard(input.cardId, { include: [] }, null);
      const card = existing.card as Record<string, unknown> | undefined;
      if (typeof card?.folderId !== "string") throw failure("Card folder is unavailable", 404);
      preflightFolderId = card.folderId;
      assertCardFolder(preflightFolderId);
      await this.options.authorizeFolder(preflightFolderId, actor);
    }

    const result = await this.options.sql.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`;
      const prior = (await sql<StoredOperation[]>`
        SELECT * FROM folder_operations WHERE idempotency_key=${idempotencyKey} LIMIT 1
      `)[0];
      if (prior) {
        return {
          receipt: input.kind === "create"
            ? await this.replayCreate(sql, input, actor, prior)
            : await this.replayFollowup(sql, input, actor, prior),
          changed: false,
          folderId: prior.folder_id,
        };
      }

      if (input.kind === "create") {
        const created = await this.create(sql, input, actor, idempotencyKey);
        return { ...created, changed: true };
      }

      const card = (await sql<CardRow[]>`SELECT * FROM cards WHERE id=${input.cardId} FOR UPDATE`)[0];
      if (!card) throw failure("Card not found", 404);
      assertCardFolder(card.folder_id);
      if (card.folder_id !== preflightFolderId) await this.options.authorizeFolder(card.folder_id, actor);
      const ownerSessionId = card.assignee_kind === "session" ? card.assignee_session_id : null;
      if (!ownerSessionId) throw failure("Card has no assigned session", 409);
      const owner = (await sql<{ session_id: string }[]>`
        SELECT session_id FROM sessions WHERE session_id=${ownerSessionId} AND card_id=${card.id} FOR SHARE
      `)[0];
      if (!owner) throw failure("Assigned session does not own this card", 409);

      const commentId = randomUUID();
      const body = followupBody(input.request, input.brief ?? "");
      const mutation = await this.options.cards.addCommentTx(sql, {
        actorKind: actor.actorKind,
        actorSessionId: actor.actorSessionId,
        actorUserId: null,
        cardId: card.id,
        expectedVersion: card.version,
        idempotencyKey,
        commentId,
        body,
        mode: "spoken",
      });
      const notification = buildCardChangeNotification({
        result: { operation: mutation.operation, idempotent: false },
        previousStatus: card.status,
        previousAssigneeSessionId: card.assignee_session_id,
        committedCard: mutation.card,
      }, mutation.comment);
      if (!notification) throw failure("Followup delivery target is unavailable", 409);

      const canonical = buildCanonicalDeliveryPayload({
        text: notification.text,
        user: "",
        source: "card_change",
        relationKey: notification.deliveryId,
        completionId: notification.deliveryId,
        callerInfo: { source: "agent", session_id: actor.actorSessionId },
      });
      const registered = await registerSessionDelivery(sql as unknown as DeliverySqlClient, {
        deliveryId: notification.deliveryId,
        targetSessionId: notification.sessionId,
        sourceSessionId: mutation.operation.actor_session_id,
        relationKey: notification.deliveryId,
        completionId: notification.deliveryId,
        intent: "durable_next_turn",
        source: "card_change",
        producerId: mutation.operation.id,
        payloadHash: canonical.payloadHash,
        payload: canonical.payload,
        createdAt: new Date(),
      });
      if (registered.conflict) throw failure("Followup delivery identity conflict", 409);
      return {
        receipt: {
          accepted: true as const,
          idempotent: false,
          operationId: mutation.operation.id,
          card: { id: card.id, number: mutation.card.number },
          work: { kind: "delivery" as const, deliveryId: registered.row.delivery_id, sessionId: notification.sessionId },
        },
        changed: true,
        folderId: card.folder_id,
      };
    });

    if (result.changed && result.folderId) await this.emitCardUpdated(result.receipt.card.id, result.folderId);
    return result.receipt;
  }

  async kick(receipt: AcceptedWork): Promise<void> {
    if (receipt.work.kind === "execution") {
      const operation = await this.readDispatchOperation(receipt.operationId, receipt.card.id, "create_card");
      const request = (await this.options.sql<CardExecutionRequest[]>`
        SELECT * FROM card_execution_requests WHERE id=${receipt.work.requestId}
      `)[0];
      if (!request || request.card_id !== receipt.card.id || request.session_id !== receipt.work.sessionId
        || request.idempotency_key !== `dispatch-work-execution:${operation.id}`) {
        throw failure("Saved execution reservation does not match receipt", 409);
      }
      if (request.state !== "pending") return;
      if (operation.actor_kind !== "agent" || !operation.actor_session_id) throw failure("Saved dispatch actor is unavailable", 409);
      await this.options.execution.startReserved(request.id, {
        actorKind: "agent",
        actorSessionId: operation.actor_session_id,
        actorUserId: operation.actor_user_id,
      });
      return;
    }

    const operation = await this.readDispatchOperation(receipt.operationId, receipt.card.id, "add_card_comment");
    const commentId = stringField(operation.payload_json.comment_id);
    if (!commentId) throw failure("Saved followup comment is unavailable", 409);
    const delivery = (await this.options.sql<DeliveryQueryRow[]>`
      SELECT * FROM session_deliveries
      WHERE delivery_id=${receipt.work.deliveryId} AND producer_id=${operation.id}
        AND source='card_change' AND target_session_id=${receipt.work.sessionId}
    `)[0];
    if (!delivery) throw failure("Saved followup delivery is unavailable", 409);
    await this.options.sendDelivery(delivery);
    const current = (await this.options.sql<DeliveryQueryRow[]>`
      SELECT * FROM session_deliveries WHERE delivery_id=${delivery.delivery_id}
    `)[0];
    if (isAccepted(current)) await this.options.cards.markCommentDelivered(receipt.card.id, commentId);
  }

  async kickPendingForNode(nodeId: string): Promise<void> {
    const rows = await this.options.sql<Array<{
      operation_id: string;
      card_id: string;
      number: number | null;
      request_id: string;
      session_id: string;
    }>>`
      SELECT op.id AS operation_id,c.id AS card_id,c.number,r.id AS request_id,r.session_id
      FROM card_execution_requests r
      JOIN folder_operations op ON r.idempotency_key='dispatch-work-execution:'||op.id
      JOIN cards c ON c.id=r.card_id
      WHERE r.state='pending' AND r.target->>'nodeId'=${nodeId}
        AND op.operation_type='create_card' AND op.actor_kind='agent'
        AND op.actor_session_id IS NOT NULL
        AND op.idempotency_key LIKE 'dispatch-work:'||op.actor_session_id||':%'
      ORDER BY r.created_at,r.id
    `;
    for (const row of rows) {
      try {
        await this.kick({
          accepted: true,
          idempotent: true,
          operationId: row.operation_id,
          card: { id: row.card_id, number: row.number },
          work: { kind: "execution", requestId: row.request_id, sessionId: row.session_id },
        });
      } catch (error) {
        this.options.warn(`Pending card work kick failed for ${row.request_id}: ${errorMessage(error)}`);
      }
    }
  }

  private async create(sql: RepositorySql, input: Extract<DispatchWorkInput, { kind: "create" }>,
    actor: DispatchWorkActor, idempotencyKey: string): Promise<NewlyAcceptedWork> {
    const defaults = (await sql<CallerSessionDefaults[]>`
      SELECT folder_id,agent_id,node_id,model_preset FROM sessions WHERE session_id=${actor.actorSessionId} FOR UPDATE
    `)[0];
    if (!defaults?.agent_id) throw failure("Dispatch actor session has no agent identity", 403);
    const folderId = input.folderId ?? defaults.folder_id;
    if (!folderId) throw failure("A regular target folder is required", 422);
    assertCardFolder(folderId);
    await this.options.authorizeFolder(folderId, actor);
    const assigneeAgentId = input.agentId ?? defaults.agent_id;
    const cardId = randomUUID();
    const created = await this.options.cards.createCardTx(sql, {
      actorKind: actor.actorKind,
      actorSessionId: actor.actorSessionId,
      actorUserId: null,
      cardId,
      folderId,
      title: input.title,
      request: input.request,
      brief: input.brief ?? "",
      assignee: { kind: "agent", agentId: assigneeAgentId },
      nodeId: input.nodeId ?? defaults.node_id,
      modelPreset: input.modelPreset ?? defaults.model_preset,
      queue: false,
      idempotencyKey,
    });
    const request = await this.options.execution.reserveTx(sql, {
      actorKind: actor.actorKind,
      actorSessionId: actor.actorSessionId,
      actorUserId: null,
      cardId: created.card.id,
      expectedVersion: created.card.version,
      idempotencyKey: `dispatch-work-execution:${created.operation.id}`,
    });
    return {
      receipt: {
        accepted: true,
        idempotent: false,
        operationId: created.operation.id,
        card: { id: created.card.id, number: created.card.number },
        work: { kind: "execution", requestId: request.id, sessionId: request.session_id },
      },
      folderId: created.card.folder_id,
    };
  }

  private async replayCreate(sql: RepositorySql, input: Extract<DispatchWorkInput, { kind: "create" }>,
    actor: DispatchWorkActor, operation: StoredOperation): Promise<AcceptedWork> {
    assertOperation(operation, actor, "create_card");
    const payload = operation.payload_json;
    if (operation.target_kind !== "card" || !sameString(payload.request, input.request)
      || !sameString(payload.title, input.title) || !sameString(payload.brief, input.brief ?? "")
      || input.folderId !== undefined && operation.folder_id !== input.folderId
      || input.agentId !== undefined && assigneeAgent(payload.assignee) !== input.agentId
      || input.nodeId !== undefined && payload.nodeId !== input.nodeId
      || input.modelPreset !== undefined && payload.modelPreset !== input.modelPreset) {
      throw failure("Idempotency key is already bound to different work", 409);
    }
    if (!operation.folder_id) throw failure("Saved card folder is unavailable", 409);
    assertCardFolder(operation.folder_id);
    await this.options.authorizeFolder(operation.folder_id, actor);
    const card = await this.readCard(sql, operation.target_id);
    const request = (await sql<CardExecutionRequest[]>`
      SELECT * FROM card_execution_requests WHERE idempotency_key=${`dispatch-work-execution:${operation.id}`}
    `)[0];
    if (!request || request.card_id !== card.id) throw failure("Saved execution reservation is unavailable", 409);
    return {
      accepted: true,
      idempotent: true,
      operationId: operation.id,
      card: { id: card.id, number: card.number },
      work: { kind: "execution", requestId: request.id, sessionId: request.session_id },
    };
  }

  private async replayFollowup(sql: RepositorySql, input: Extract<DispatchWorkInput, { kind: "followup" }>,
    actor: DispatchWorkActor, operation: StoredOperation): Promise<AcceptedWork> {
    assertOperation(operation, actor, "add_card_comment");
    if (operation.target_kind !== "card" || operation.target_id !== input.cardId
      || !sameString(operation.payload_json.body, followupBody(input.request, input.brief ?? ""))) {
      throw failure("Idempotency key is already bound to different work", 409);
    }
    const card = await this.readCard(sql, operation.target_id);
    const rows = await sql<DeliveryQueryRow[]>`
      SELECT * FROM session_deliveries
      WHERE producer_id=${operation.id} AND source='card_change' AND producer_kind IS NULL
    `;
    if (rows.length !== 1 || !rows[0]?.target_session_id) throw failure("Saved followup delivery is unavailable", 409);
    return {
      accepted: true,
      idempotent: true,
      operationId: operation.id,
      card: { id: card.id, number: card.number },
      work: { kind: "delivery", deliveryId: rows[0].delivery_id, sessionId: rows[0].target_session_id },
    };
  }

  private async readCard(sql: RepositorySql, cardId: string): Promise<CardRow> {
    const card = (await sql<CardRow[]>`SELECT * FROM cards WHERE id=${cardId}`)[0];
    if (!card) throw failure("Saved card is unavailable", 404);
    return card;
  }

  private async readDispatchOperation(operationId: string, cardId: string, operationType: string): Promise<StoredOperation> {
    const operation = (await this.options.sql<StoredOperation[]>`
      SELECT * FROM folder_operations WHERE id=${operationId}
    `)[0];
    if (!operation || operation.target_kind !== "card" || operation.target_id !== cardId
      || operation.operation_type !== operationType || operation.actor_kind !== "agent"
      || !operation.actor_session_id || operation.idempotency_key?.startsWith(`dispatch-work:${operation.actor_session_id}:`) !== true) {
      throw failure("Saved dispatch operation is unavailable", 409);
    }
    return operation;
  }

  private async emitCardUpdated(cardId: string, folderId: string): Promise<void> {
    try {
      await this.options.emitCardUpdated(cardId, folderId);
    } catch (error) {
      this.options.warn(`Card update broadcast failed for ${cardId}: ${errorMessage(error)}`);
    }
  }
}

type DeliverySqlClient = import("../control_plane/control_plane_types.js").SqlClient;

function assertInput(input: DispatchWorkInput, actor: DispatchWorkActor): void {
  if (actor.actorKind !== "agent" || !actor.actorSessionId.trim()) throw failure("Authenticated agent session is required", 403);
  if (!input.idempotencyKey.trim() || !input.request.trim()) throw failure("Request and idempotency key are required", 400);
  if (input.kind === "create") {
    if (!input.title.trim()) throw failure("Card title is required", 400);
    for (const value of [input.folderId, input.agentId, input.modelPreset, input.nodeId]) {
      if (value !== undefined && !value.trim()) throw failure("Explicit target values cannot be empty", 400);
    }
  }
}

function assertCardFolder(folderId: string): void {
  if (systemFolders.has(folderId)) throw failure("A regular card folder is required", 403);
}

function assertOperation(operation: StoredOperation, actor: DispatchWorkActor, operationType: string): void {
  if (operation.actor_kind !== "agent" || operation.actor_session_id !== actor.actorSessionId
    || operation.operation_type !== operationType) throw failure("Idempotency key is already bound to different work", 409);
}

function followupBody(request: string, brief: string): string {
  return `요청 원문:\n${request}\n\n필요한 맥락과 완료기준:\n${brief}`;
}

function assigneeAgent(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const agentId = (value as Record<string, unknown>).agentId;
  return typeof agentId === "string" ? agentId : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sameString(value: unknown, expected: string): boolean {
  return typeof value === "string" && value === expected;
}

function isAccepted(row: SessionDeliveryRow | undefined): boolean {
  return !!row && (row.state === "queued" || row.state === "delivered" || row.aggregate_state === "consumed");
}

function failure(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

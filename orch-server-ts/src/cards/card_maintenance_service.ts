import { readRemainingCardDecision } from './card_remaining_evidence_reader.js';
import { decodeCardDecision } from './state/card_decision_decoder.js';
import { formatCardDecisionFailure } from './state/card_decision_errors.js';
import type { CardDecision } from './state/card_decision.js';
import type { CardCommand } from './state/card_decision_facts.js';
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AttachmentRef } from "@soulstream/wire-schema/attachments";
import { attachmentRefsOf } from "./card_attachment_refs.js";
import { mergeCardSourceAttachmentRefs, type CardLegacyAttachmentRef } from "./card_attachment_legacy_refs.js";
import {
  appendBriefSection, appendRequestSection, cardLabel, cardNotFound, describeCard,
  invalidMaintenance, lockCardTx, lockCardsTx, mergeCardItems, mergedCloseNow, readCardTx, readMergeCommentsTx,
  readOperationTx, requireMaintenanceSession, unionAttachments, updateAttachmentRefsTx,
  type BulkStatus, type CardCommentRow,
} from "./card_maintenance_tx.js";
import { CardMutationCore } from "./control_plane/card_mutation_core.js";
import { CardRepository } from "./control_plane/card_repository.js";
import { CardVersionConflict, assigneeToFields } from "./control_plane/card_models.js";
import type { CardRow, CardStatus, FolderActorParams, FolderOperationRow, RepositorySql, SqlClient } from "./control_plane/card_types.js";

export type AuthorizeFolder = (folderId: string) => Promise<void>;

export type UpdateUnstartedFields = {
  title?: string;
  request?: string;
  brief?: string;
  agentId?: string;
  modelPreset?: string;
  nodeId?: string;
};

export type UpdateUnstartedInput = FolderActorParams & UpdateUnstartedFields & {
  cardId: string;
  expectedVersion?: number;
  idempotencyKey: string;
};

export type MergeCardsInput = FolderActorParams & {
  targetCardId: string;
  sourceCardIds: string[];
  title?: string;
  idempotencyKey: string;
};

export type BulkSetCardStatusInput = FolderActorParams & {
  cardIds: string[];
  status: BulkStatus;
  reason?: string;
  idempotencyKey: string;
};

export type CompactCard = { id: string; number: number | null; version: number; status: CardStatus };
export type UpdateUnstartedResult = { card: CompactCard; changed_fields: string[]; idempotent: boolean };
export type MergeCardsResult = {
  card: CompactCard;
  merged_cards: { id: string; number: number | null; title: string }[];
  moved: { request_sections: number; comments: number; notes: number; items: number; attachments: number };
  idempotent: boolean;
};
export type BulkStatusItem =
  | { card_id: string; number: number | null; ok: true; status: CardStatus; version: number }
  | { card_id: string; ok: false; error: string };

/** One committed card, ready for report sync, board broadcast and dispatcher notification. */
export type CardMaintenanceChange = {
  result: { operation: FolderOperationRow; eventId: number | null };
  previousStatus: CardStatus;
  previousAssigneeSessionId: string | null;
  committedCard: CardRow;
  cardChanged: boolean;
};

export type CardMaintenancePorts = {
  sql: SqlClient;
  repo: CardRepository;
  core: CardMutationCore;
  patchTx: (sql: RepositorySql, card: CardRow, fields: Record<string, unknown>, actor: FolderActorParams, eventId: number | null) => Promise<void>;
  statusTx: (sql: RepositorySql, card: CardRow, eventId: number | null,
    params: FolderActorParams & { cardId: string; status: CardStatus; expectedVersion?: number; reason?: string | null }, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  afterCommit: (changes: CardMaintenanceChange[]) => Promise<void>;
};

const maintenanceStorageKey = (tool: string, actorSessionId: string, key: string) =>
  `card-maintenance:${tool}:${actorSessionId}:${key}`;

const normalizeRecord = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? {}));

function requireIdempotencyKey(key: string): string {
  if (typeof key !== "string" || key.trim() === "") throw invalidMaintenance("idempotency_key가 필요합니다.");
  return key;
}

function idempotencyConflict(): Error {
  return Object.assign(new Error("같은 idempotency_key에 다른 요청이 이미 기록되어 있습니다."),
    { statusCode: 409, code: "FOLDER_IDEMPOTENCY_CONFLICT" });
}

function compactCard(card: CardRow): CompactCard {
  return { id: card.id, number: card.number, version: card.version, status: card.status };
}

function updateChangedFields(params: UpdateUnstartedFields): string[] {
  const fields = [
    params.title !== undefined ? "title" : null,
    params.request !== undefined ? "request" : null,
    params.brief !== undefined ? "brief" : null,
    params.agentId !== undefined ? "agent_id" : null,
    params.modelPreset !== undefined ? "model_preset" : null,
    params.nodeId !== undefined ? "node_id" : null,
  ].filter((field): field is string => field !== null);
  if (fields.length === 0) throw invalidMaintenance("변경할 필드를 하나 이상 지정하세요.");
  return fields;
}

/** Raw card reads inside a transaction must use its connection; the pool may hold only one. */
async function readCardOrFail(sql: RepositorySql, cardId: string): Promise<CardRow> {
  const card = await readCardTx(sql, cardId);
  if (!card) throw cardNotFound(cardId);
  return card;
}

export class CardMaintenanceService {
  private readonly sql: SqlClient;
  private readonly repo: CardRepository;
  private readonly core: CardMutationCore;
  private readonly patchTx: CardMaintenancePorts["patchTx"];
  private readonly statusTx: CardMaintenancePorts["statusTx"];
  private readonly afterCommitCards: CardMaintenancePorts["afterCommit"];

  constructor(ports: CardMaintenancePorts) {
    this.sql = ports.sql;
    this.repo = ports.repo;
    this.core = ports.core;
    this.patchTx = ports.patchTx;
    this.statusTx = ports.statusTx;
    this.afterCommitCards = ports.afterCommit;
  }

  async updateUnstartedCard(params: UpdateUnstartedInput, authorizeFolder: AuthorizeFolder): Promise<UpdateUnstartedResult> {
    const actorSessionId = requireMaintenanceSession(params,'UPDATE_UNSTARTED');
    const idempotencyKey = requireIdempotencyKey(params.idempotencyKey);
    const changedFields = updateChangedFields(params);
    const storageKey = maintenanceStorageKey("update_unstarted_card", actorSessionId, idempotencyKey);
    const input: Record<string, unknown> = { card_id: params.cardId };
    for (const [key, value] of [["title", params.title], ["request", params.request], ["brief", params.brief],
      ["agent_id", params.agentId], ["model_preset", params.modelPreset], ["node_id", params.nodeId],
      ["expected_version", params.expectedVersion]] as const)
      if (value !== undefined) input[key] = value;

    const current = await readCardOrFail(this.sql, params.cardId);
    await authorizeFolder(current.folder_id);

    const outcome = await this.sql.begin(async (sql): Promise<{ result: UpdateUnstartedResult; change?: CardMaintenanceChange }> => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${storageKey},0))`;
      const prior = await readOperationTx(sql, storageKey);
      if (prior) {
        assertReplay(prior, "update_unstarted_card", params.cardId, input);
        await authorizeFolder((await readCardOrFail(sql, params.cardId)).folder_id);
        const stored = prior.payload_json.result as Omit<UpdateUnstartedResult, "idempotent">;
        return { result: { ...stored, idempotent: true } };
      }
      const locked = await lockCardTx(sql, params.cardId);
      await authorizeFolder(locked.folder_id);
      const command={...params,type:'UPDATE_UNSTARTED'} as const;
      const decision=await this.decide(sql,locked,command,params);
      if (params.expectedVersion !== undefined && locked.version !== params.expectedVersion)
        throw new CardVersionConflict("card", locked.id, params.expectedVersion, locked.version);

      const previousStatus = locked.status;
      const previousAssigneeSessionId = locked.assignee_session_id;
      const payload: Record<string, unknown> = { input, result: null };
      let committed!: CardRow;
      let result!: UpdateUnstartedResult;
      const applied = await this.core.mutateTx(sql, {
        folderId: locked.folder_id, targetKind: "card", targetId: locked.id,
        operationType: "update_unstarted_card", actor: params, idempotencyKey: storageKey, payload,
        apply: async (tx, eventId) => {
          const fields = await this.updateFieldsTx(tx, locked, params);
          await this.patchTx(tx, locked, this.fields(decision,locked,command,params,eventId,fields), params, eventId);
          committed = await readCardOrFail(tx, locked.id);
          result = { card: compactCard(committed), changed_fields: changedFields, idempotent: false };
          payload.result = { card: result.card, changed_fields: result.changed_fields };
        },
      });
      return {
        result,
        change: { result: applied, previousStatus, previousAssigneeSessionId, committedCard: committed, cardChanged: true },
      };
    });
    if (outcome.change) await this.afterCommitCards([outcome.change]);
    return outcome.result;
  }

  private async updateFieldsTx(sql: RepositorySql, card: CardRow, params: UpdateUnstartedInput): Promise<Record<string, unknown>> {
    const fields: Record<string, unknown> = {};
    if (params.title !== undefined) fields.title = params.title;
    if (params.brief !== undefined) fields.brief = params.brief;
    if (params.agentId !== undefined) Object.assign(fields, assigneeToFields({ kind: "agent", agentId: params.agentId }));
    if (params.modelPreset !== undefined) fields.model_preset = params.modelPreset;
    if (params.nodeId !== undefined) fields.node_id = params.nodeId;
    if (params.request !== undefined) {
      const refs = await updateAttachmentRefsTx(sql, card, params.request, params);
      fields.request = params.request;
      fields.attachment_refs = sql.json(refs);
    }
    return fields;
  }

  async mergeCards(params: MergeCardsInput, authorizeFolder: AuthorizeFolder): Promise<MergeCardsResult> {
    const actorSessionId = requireMaintenanceSession(params,'MERGE_SOURCE');
    const idempotencyKey = requireIdempotencyKey(params.idempotencyKey);
    const sourceCardIds = [...params.sourceCardIds];
    const unique = new Set(sourceCardIds);
    if (unique.size !== sourceCardIds.length || unique.has(params.targetCardId))
      throw invalidMaintenance("대상과 원 카드는 서로 달라야 하며 원 카드를 중복 지정할 수 없습니다.");
    const storageKey = maintenanceStorageKey("merge_cards", actorSessionId, idempotencyKey);
    const input: Record<string, unknown> = { target_card_id: params.targetCardId, source_card_ids: sourceCardIds };
    if (params.title !== undefined) input.title = params.title;

    const participantIds = [params.targetCardId, ...sourceCardIds];
    for (const cardId of participantIds) await authorizeFolder((await readCardOrFail(this.sql, cardId)).folder_id);

    const outcome = await this.sql.begin(async (sql): Promise<{ result: MergeCardsResult; changes: CardMaintenanceChange[] }> => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${storageKey},0))`;
      const prior = await readOperationTx(sql, storageKey);
      if (prior) {
        assertReplay(prior, "merge_cards", params.targetCardId, input);
        for (const cardId of participantIds) await authorizeFolder((await readCardOrFail(sql, cardId)).folder_id);
        const stored = prior.payload_json.result as Omit<MergeCardsResult, "idempotent">;
        return { result: { ...stored, idempotent: true }, changes: [] };
      }

      const locked = await lockCardsTx(sql, participantIds, new Map(participantIds.map(cardId => [cardId, cardId])));
      for (const card of locked.values()) await authorizeFolder(card.folder_id);
      const target = locked.get(params.targetCardId)!;
      const sources = sourceCardIds.map(cardId => locked.get(cardId)!);
      const targetCommand={type:'UPDATE_UNSTARTED'} as const;
      const targetDecision=await this.decide(sql,target,targetCommand,params);
      const sourceDecisions=new Map<string,CardDecision>();
      for (const source of sources) sourceDecisions.set(source.id,await this.decide(sql,source,{type:'MERGE_SOURCE'},params));

      const comments = await readMergeCommentsTx(sql, sourceCardIds);
      const commentsByCard = new Map<string, CardCommentRow[]>();
      for (const row of comments) {
        const rows = commentsByCard.get(row.card_id);
        if (rows) rows.push(row); else commentsByCard.set(row.card_id, [row]);
      }
      const finalTitle = params.title ?? target.title;
      let request = target.request;
      let brief = target.brief;
      let commentCount = 0;
      const noteCopies: { source: CardRow; row: CardCommentRow }[] = [];
      const userCommentRefs: AttachmentRef[] = [];
      for (const source of sources) {
        const rows = commentsByCard.get(source.id) ?? [];
        const userRows = rows.filter(row => row.author_kind === "user" && (row.kind === "comment" || row.kind === "spoken"));
        request = appendRequestSection(request, source, userRows);
        commentCount += userRows.length;
        for (const row of userRows) userCommentRefs.push(...attachmentRefsOf(row.attachment_refs));
        brief = appendBriefSection(brief, source);
        for (const row of rows) if (row.kind === "note") noteCopies.push({ source, row });
      }
      const attachmentUnion = unionAttachments(target.attachments ?? [], sources.flatMap(source => source.attachments ?? []));
      const itemMerge = mergeCardItems(target.items ?? [], sources);
      const refs = mergeCardSourceAttachmentRefs([], [
        ...attachmentRefsOf(target.attachment_refs),
        ...sources.flatMap(source => attachmentRefsOf(source.attachment_refs)),
        ...userCommentRefs,
        ...noteCopies.flatMap(copy => attachmentRefsOf(copy.row.attachment_refs)),
      ] as unknown as CardLegacyAttachmentRef[]);
      const targetNote = `합친 카드: ${sources.map(describeCard).join(", ")}`;
      const sourceNote = `이 카드는 ${cardLabel(target)} 「${finalTitle}」에 합쳐 닫았다`;

      const changes: CardMaintenanceChange[] = [];
      for (const source of sources) {
        const sourcePayload: Record<string, unknown> = {
          status: "cancelled", merge_target_card_id: target.id, merge_key: storageKey, result: null,
        };
        let sourceCommitted!: CardRow;
        const sourceApplied = await this.core.mutateTx(sql, {
          folderId: source.folder_id, targetKind: "card", targetId: source.id,
          operationType: "set_card_status", actor: params,
          idempotencyKey: `${storageKey}:source:${source.id}`, payload: sourcePayload,
          apply: async (tx, eventId) => {
            await tx`INSERT INTO card_comments(id,card_id,author_kind,author_id,session_id,kind,body,attachment_refs)
              VALUES(${randomUUID()},${source.id},'agent',NULL,${actorSessionId},'note',${sourceNote},${tx.json([])})`;
            await this.patchTx(tx, source, this.fields(sourceDecisions.get(source.id)!,source,{type:'MERGE_SOURCE'},params,eventId,{},
              {'formatted.merge':()=>tx.json(mergedCloseNow(target,new Date().toISOString(),actorSessionId))}), params, eventId);
            sourceCommitted = await readCardOrFail(tx, source.id);
            sourcePayload.result = { card_id: source.id, number: source.number, status: sourceCommitted.status, version: sourceCommitted.version };
          },
        });
        changes.push({
          result: sourceApplied, previousStatus: source.status,
          previousAssigneeSessionId: source.assignee_session_id, committedCard: sourceCommitted, cardChanged: true,
        });
      }

      const targetPayload: Record<string, unknown> = { input, result: null };
      let targetCommitted!: CardRow;
      let merged!: MergeCardsResult;
      const targetApplied = await this.core.mutateTx(sql, {
        folderId: target.folder_id, targetKind: "card", targetId: target.id,
        operationType: "merge_cards", actor: params, idempotencyKey: storageKey, payload: targetPayload,
        apply: async (tx, eventId) => {
          for (const { source, row } of noteCopies) {
            const itemId = row.item_id === null ? null : itemMerge.itemIdMap.get(`${source.id}:${row.item_id}`) ?? null;
            await tx`INSERT INTO card_comments(id,card_id,author_kind,author_id,session_id,kind,body,item_id,attachment_refs)
              VALUES(${randomUUID()},${target.id},${row.author_kind},${row.author_id},${row.session_id},'note',
              ${`[${cardLabel(source)}에서 옮김] ${row.body}`},${itemId},${tx.json(row.attachment_refs ?? [])})`;
          }
          await tx`INSERT INTO card_comments(id,card_id,author_kind,author_id,session_id,kind,body,attachment_refs)
            VALUES(${randomUUID()},${target.id},'agent',NULL,${actorSessionId},'note',${targetNote},${tx.json([])})`;
          const fields: Record<string, unknown> = {
            request, brief,
            attachments: tx.json(attachmentUnion.attachments),
            attachment_refs: tx.json(refs),
            items: tx.json(itemMerge.items),
          };
          if (params.title !== undefined) fields.title = params.title;
          await this.patchTx(tx, target, this.fields(targetDecision,target,targetCommand,params,eventId,fields), params, eventId);
          targetCommitted = await readCardOrFail(tx, target.id);
          merged = {
            card: compactCard(targetCommitted),
            merged_cards: sources.map(source => ({ id: source.id, number: source.number, title: source.title })),
            moved: {
              request_sections: sources.length,
              comments: commentCount,
              notes: noteCopies.length,
              items: itemMerge.items.length - (target.items ?? []).length,
              attachments: attachmentUnion.added,
            },
            idempotent: false,
          };
          targetPayload.result = { card: merged.card, merged_cards: merged.merged_cards, moved: merged.moved };
        },
      });
      changes.push({
        result: targetApplied, previousStatus: target.status,
        previousAssigneeSessionId: target.assignee_session_id, committedCard: targetCommitted, cardChanged: true,
      });
      return { result: merged, changes };
    });
    await this.afterCommitCards(outcome.changes);
    return outcome.result;
  }

  private async decide(sql:RepositorySql,card:CardRow,command:CardCommand,params:FolderActorParams) {
    const decision=await readRemainingCardDecision(sql,card,command,params);
    if(decision.kind==='reject'){
      const failure=formatCardDecisionFailure(decision.failure,{label:cardLabel(card),status:card.status});
      throw Object.assign(new Error(failure.message),{statusCode:failure.statusCode,code:failure.code});
    }
    return decision;
  }
  private fields(decision:CardDecision,card:CardRow,command:CardCommand,params:FolderActorParams,eventId:number|null,
    control:Record<string,unknown>,lazy:Record<string,()=>unknown>={}) {
    const writes=decodeCardDecision(decision,{card,command,actor:{kind:params.actorKind??'agent',sessionId:params.actorSessionId,userId:params.actorUserId},
      now:new Date(),eventId,values:{'command.control':control},lazy});
    const fields=Object.assign({},...writes.filter(write=>write.kind==='card').map(write=>write.fields));
    return fields;
  }

  async bulkSetCardStatus(params: BulkSetCardStatusInput, authorizeFolder: AuthorizeFolder): Promise<{ results: BulkStatusItem[] }> {
    const actorSessionId = requireMaintenanceSession(params,'BULK_SET_STATUS');
    const idempotencyKey = requireIdempotencyKey(params.idempotencyKey);
    const results: BulkStatusItem[] = [];
    for (const cardId of params.cardIds) {
      try {
        results.push(await this.applyBulkCard({ ...params, cardId }, actorSessionId, idempotencyKey, authorizeFolder));
      } catch (error) {
        results.push({ card_id: cardId, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { results };
  }

  private async applyBulkCard(params: BulkSetCardStatusInput & { cardId: string }, actorSessionId: string,
    idempotencyKey: string, authorizeFolder: AuthorizeFolder): Promise<BulkStatusItem> {
    const storageKey = maintenanceStorageKey("bulk_set_card_status", actorSessionId, `${idempotencyKey}:${params.cardId}`);
    const input: Record<string, unknown> = { card_id: params.cardId, status: params.status, idempotency_key: idempotencyKey };
    if (params.reason !== undefined) input.reason = params.reason;

    const current = await readCardOrFail(this.sql, params.cardId);
    await authorizeFolder(current.folder_id);

    const outcome = await this.sql.begin(async (sql): Promise<{ result: BulkStatusItem; change?: CardMaintenanceChange }> => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${storageKey},0))`;
      const prior = await readOperationTx(sql, storageKey);
      if (prior) {
        assertReplay(prior, "set_card_status", params.cardId, input);
        await authorizeFolder((await readCardOrFail(sql, params.cardId)).folder_id);
        return { result: prior.payload_json.result as BulkStatusItem };
      }
      const locked = await lockCardTx(sql, params.cardId);
      await authorizeFolder(locked.folder_id);
      const previousStatus = locked.status;
      const previousAssigneeSessionId = locked.assignee_session_id;
      const payload: Record<string, unknown> = { status: params.status, blocked_kind: null, blocked_detail: null, input, result: null };
      let committed!: CardRow;
      let result!: BulkStatusItem;
      const applied = await this.core.mutateTx(sql, {
        folderId: locked.folder_id, targetKind: "card", targetId: locked.id,
        operationType: "set_card_status", actor: params, idempotencyKey: storageKey, payload, reason: params.reason,
        apply: async (tx, eventId) => {
          const fields = await this.statusTx(tx, locked, eventId, { ...params, status: params.status }, payload);
          if (params.reason !== undefined)
            await tx`INSERT INTO card_comments(id,card_id,author_kind,author_id,session_id,kind,body,attachment_refs)
              VALUES(${randomUUID()},${locked.id},'agent',NULL,${actorSessionId},'note',${params.reason},${tx.json([])})`;
          await this.patchTx(tx, locked, fields, params, eventId);
          committed = await readCardOrFail(tx, locked.id);
          result = { card_id: committed.id, number: committed.number, ok: true, status: committed.status, version: committed.version };
          payload.result = result;
        },
      });
      return {
        result,
        change: { result: applied, previousStatus, previousAssigneeSessionId, committedCard: committed, cardChanged: true },
      };
    });
    if (outcome.change) await this.afterCommitCards([outcome.change]);
    return outcome.result;
  }
}

/** A replayed key must name the same operation on the same target with the same normalized input. */
function assertReplay(prior: FolderOperationRow, operationType: string, targetId: string, input: Record<string, unknown>): void {
  if (prior.operation_type !== operationType || prior.target_id !== targetId
    || !isDeepStrictEqual(normalizeRecord(prior.payload_json.input), normalizeRecord(input)))
    throw idempotencyConflict();
}

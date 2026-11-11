import { randomUUID } from "node:crypto";
import { z } from "zod";
import { inlineUploadId } from "../attachments/upload_identity.js";
import type {
  CardCommentAttachmentUploadInput,
  CardCommentAttachmentUploadResult,
  FolderRouteOptions,
} from "../folders/folder_routes.js";
import { filterFolders, isFolderAllowed, normalizeAccess, type FolderAccess } from "../folders/folder_route_access.js";
import { serializeCardRow } from "../folders/folder_contracts.js";
import { describeFolderOperationError } from "../folders/folder_workspace_routes.js";
import { parseCardQuery } from "./completed_card_query.js";
import { CardOperationError, executeCardOperation, serializeCardDetail, type CardDetail, type CardOperation } from "./card_operations.js";
import type { FolderActorParams } from "./control_plane/card_types.js";

export type CardRouteBodyOptions = Pick<FolderRouteOptions, "cardServiceProvider" | "provider">;
type ResolveAccess = () => FolderAccess | Promise<FolderAccess>;
type BoundCommentAttachmentUpload = (
  input: CardCommentAttachmentUploadInput,
) => Promise<CardCommentAttachmentUploadResult>;

export const inlineAttachmentSchema = z
  .object({
    name: z.string().min(1),
    mime: z.string(),
    data_base64: z.string().min(1),
  })
  .strict();

export const sendCardMessageSchema = z
  .object({
    sessionId: z.string().min(1).nullable().optional(),
    text: z.string().optional().default(""),
    idempotencyKey: z.string().min(1).optional(),
    attachments: z.array(inlineAttachmentSchema).max(10).optional(),
  })
  .strict();

export class CardNotFoundError extends Error {
  readonly statusCode = 404;
  readonly body = { detail: { error: { code: "CARD_NOT_FOUND" } } };
}

export async function listCardRouteBody(options: CardRouteBodyOptions, input: unknown, resolveAccess: ResolveAccess) {
  const service = await options.cardServiceProvider!();
  const query = parseCardQuery(input);
  const [access, folders] = await Promise.all([resolveAccess(), options.provider.listFolders()]);
  const normalized = normalizeAccess(access);
  const allowedFolderIds = normalized.restricted ? filterFolders(normalized, folders).map(folder => folder.id) : null;
  if (query.status === "done") {
    const page = await service.listCompletedCards({ ...query, allowedFolderIds });
    return { cards: page.cards.map(serializeCardRow), nextCursor: page.nextCursor };
  }
  if (query.paged) {
    const page = await service.listPagedCards({ folderId: query.folderId, status: query.status,
      includeClosed: query.includeClosed, allowedFolderIds, q: query.q, limit: query.limit, after: query.pagedAfter });
    return { cards: page.cards.map(serializeCardRow), nextCursor: page.nextCursor };
  }
  const cards = await service.listCards({ ...query, allowedFolderIds });
  return { cards: (await service.projectCards(cards)).map(serializeCardRow) };
}

export async function readCardRouteBody(options: CardRouteBodyOptions, cardId: string, resolveAccess: ResolveAccess, reports = false) {
  const detail = await (await options.cardServiceProvider!()).getCard(cardId);
  if (!detail) throw new CardNotFoundError();
  await allowed(options, resolveAccess, detail.card.folder_id);
  return reports ? { reports: detail.reports.map(serializeCardRow) } : serializeCardDetail(detail);
}

export async function mutateCardRouteBody(options: CardRouteBodyOptions, operation: CardOperation,
  cardId: string | undefined, input: unknown, resolveAccess: ResolveAccess,
  resolveActor: () => FolderActorParams | Promise<FolderActorParams>, questionId?: string, itemIdPath?: string | number,
  uploadCommentAttachment?: BoundCommentAttachmentUpload) {
  const service = await options.cardServiceProvider!();
  const body = z.record(z.string(), z.unknown()).parse(input);
  let detail: CardDetail | null = null;
  if (operation === "create_card") await allowed(options, resolveAccess, z.string().min(1).parse(body.folderId));
  else {
    detail = await service.getCard(cardId!);
    if (!detail) throw new CardNotFoundError();
    await allowed(options, resolveAccess, detail.card.folder_id);
  }
  if (operation === "move_card") await allowed(options, resolveAccess, z.string().min(1).parse(body.folderId));
  // Laziness preserves the existing request's access checks before actor authentication.
  const actor = await resolveActor();
  if (operation === "start_card_work" && actor.actorKind !== "agent")
    throw Object.assign(new Error("Trusted assignee session required"), { statusCode: 403 });
  let operationBody = operation === "answer_card_question" || operation === "withdraw_card_question" ? { ...body, ...(questionId === undefined ? {} : { questionId }) }
    : operation === "confirm_card_item" ? { ...body, itemId: Number(itemIdPath) } : body;
  if (operation === "add_card_comment" && detail !== null)
    operationBody = await commentOperationBody(operationBody, detail, cardId!, uploadCommentAttachment);
  const result = await executeCardOperation(service, operation, operationBody, cardId, actor);
  return { status: operation === "create_card" || operation === "add_card_report" || operation === "add_card_comment" || operation === "ask_card_question" ? 201 : 200, body: result };
}

// 커멘트에 실린 인라인 첨부를 업로드해 본문 마크다운 링크로 합친다. 링크는 카드 첨부
// 파이프라인이 해석하는 legacy 파일 URL이므로 resolveCardLegacySourceRefsTx가
// attachment_refs를 남기고 projectCardAttachmentRows가 카드 내용 URL로 투영한다.
async function commentOperationBody(
  body: Record<string, unknown>,
  detail: CardDetail,
  cardId: string,
  upload: BoundCommentAttachmentUpload | undefined,
): Promise<Record<string, unknown>> {
  const { attachments: rawAttachments, ...rest } = body;
  const attachments = rawAttachments === undefined ? [] : z.array(inlineAttachmentSchema).max(10).parse(rawAttachments);
  const text = typeof rest.body === "string" ? rest.body.trim() : "";
  if (attachments.length === 0) {
    if (text === "") throw new CardOperationError("커멘트 내용을 입력하십시오.", 422);
    return rest;
  }
  if (upload === undefined) throw new CardOperationError("카드 커멘트 첨부 업로드가 구성되지 않았습니다.", 503);
  const firstSession = detail.sessions[0];
  const sessionId = detail.card.assignee_session_id
    ?? (typeof firstSession?.session_id === "string" ? firstSession.session_id : null);
  const nodeId = detail.card.node_id
    ?? (typeof firstSession?.node_id === "string" ? firstSession.node_id : null);
  const key = typeof rest.idempotencyKey === "string" && rest.idempotencyKey.trim() !== ""
    ? rest.idempotencyKey.trim() : randomUUID();
  const links: string[] = [];
  for (const [index, file] of attachments.entries()) {
    const uploadId = inlineUploadId(`${key}:comment:${index}:${file.name}`);
    const uploaded = await upload({ cardId, folderId: detail.card.folder_id, nodeId, sessionId, file, uploadId });
    const safeName = (uploaded.name || `attachment-${index + 1}`).replace(/[[\]\r\n]/g, "_");
    links.push(uploaded.mime.toLowerCase().startsWith("image/")
      ? `![${safeName}](${uploaded.url})`
      : `[${safeName}](${uploaded.url})`);
  }
  return { ...rest, body: [text, ...links].filter(Boolean).join("\n\n") };
}

export function cardRouteErrorResponse(error: unknown) {
  if (error instanceof CardNotFoundError) return { status: error.statusCode, body: error.body };
  const failure = describeFolderOperationError(error);
  return { status: failure.status, body: { detail: { error: { code: failure.code, message: failure.message } } } };
}

export async function allowed(options: CardRouteBodyOptions, resolveAccess: ResolveAccess, folderId: string) {
  const [access, folders] = await Promise.all([resolveAccess(), options.provider.listFolders()]);
  if (!isFolderAllowed(normalizeAccess(access), folders, folderId))
    throw Object.assign(new Error("Folder access denied"), { statusCode: 403, code: "FOLDER_ACCESS_DENIED" });
  if (folderId === "claude" || folderId === "llm")
    throw Object.assign(new Error("System folders cannot own cards"), { statusCode: 403 });
}

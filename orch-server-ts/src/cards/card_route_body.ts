import { z } from "zod";
import type { FolderRouteOptions } from "../folders/folder_routes.js";
import { filterFolders, isFolderAllowed, normalizeAccess, type FolderAccess } from "../folders/folder_route_access.js";
import { serializeCardRow } from "../folders/folder_contracts.js";
import { describeFolderOperationError } from "../folders/folder_workspace_routes.js";
import { parseCardQuery } from "./completed_card_query.js";
import { executeCardOperation, serializeCardDetail, type CardOperation } from "./card_operations.js";
import type { FolderActorParams } from "./control_plane/card_types.js";

export type CardRouteBodyOptions = Pick<FolderRouteOptions, "cardServiceProvider" | "provider">;
type ResolveAccess = () => FolderAccess | Promise<FolderAccess>;

class CardNotFoundError extends Error {
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
  resolveActor: () => FolderActorParams | Promise<FolderActorParams>, questionId?: string) {
  const service = await options.cardServiceProvider!();
  const body = z.record(z.string(), z.unknown()).parse(input);
  if (operation === "create_card") await allowed(options, resolveAccess, z.string().min(1).parse(body.folderId));
  else {
    const detail = await service.getCard(cardId!);
    if (!detail) throw new CardNotFoundError();
    await allowed(options, resolveAccess, detail.card.folder_id);
  }
  if (operation === "move_card") await allowed(options, resolveAccess, z.string().min(1).parse(body.folderId));
  // Laziness preserves the existing request's access checks before actor authentication.
  const actor = await resolveActor();
  if (operation === "start_card_work" && actor.actorKind !== "agent")
    throw Object.assign(new Error("Trusted assignee session required"), { statusCode: 403 });
  const result = await executeCardOperation(service, operation,
    operation === "answer_card_question" ? { ...body, questionId } : body, cardId, actor);
  return { status: operation === "create_card" || operation === "add_card_report" || operation === "add_card_comment" || operation === "ask_card_question" ? 201 : 200, body: result };
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

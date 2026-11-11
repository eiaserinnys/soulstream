import { callWithReferenceTranslation, errorResultFromError, jsonResult, type CallToolResult } from "@soulstream/mcp-contract";
import type { AuthorizeFolder, BulkSetCardStatusInput, BulkStatusItem, UpdateUnstartedFields } from "../cards/card_maintenance_service.js";
import { allowed } from "../cards/card_route_body.js";
import { isFolderAllowed, normalizeAccess } from "../folders/folder_route_access.js";
import type { McpCallContext, McpHostOptions } from "./types.js";

type Args = Record<string, unknown>;
type Options = McpHostOptions["cards"];
type Handler = (options: Pick<McpHostOptions, "cards">, args: Args, context: McpCallContext) => Promise<CallToolResult>;
type MaintenanceActor = { actorKind: "agent"; actorSessionId: string };

/**
 * Card maintenance tools are internal-only and act as the authenticated caller session.
 * They do not go through the shared card mutation route: the service owns its transaction,
 * idempotency receipt and start-guard, and accepts an authorizer for stale folder checks.
 */
export const cardMaintenanceHandlers = {
  update_unstarted_card: (o, a, c) => {
    const actor = maintenanceActor(a, c);
    return translate(o.cards, a, translated => run(async () => {
      const service = await o.cards.cardServiceProvider!();
      const fields: UpdateUnstartedFields = {};
      for (const [argument, key] of [["title", "title"], ["request", "request"], ["brief", "brief"],
        ["agent_id", "agentId"], ["model_preset", "modelPreset"], ["node_id", "nodeId"]] as const)
        if (typeof translated[argument] === "string") fields[key] = translated[argument] as string;
      return service.updateUnstartedCard({
        cardId: String(translated.card_id),
        ...fields,
        ...(typeof translated.expected_version === "number" ? { expectedVersion: translated.expected_version } : {}),
        idempotencyKey: String(translated.idempotency_key),
        ...actor,
      }, authorizeFolder(o.cards));
    }));
  },
  merge_cards: (o, a, c) => {
    const actor = maintenanceActor(a, c);
    return translate(o.cards, a, translated => run(async () => {
      const service = await o.cards.cardServiceProvider!();
      return service.mergeCards({
        targetCardId: String(translated.target_card_id),
        sourceCardIds: (translated.source_card_ids as unknown[]).map(String),
        ...(typeof translated.title === "string" ? { title: translated.title } : {}),
        idempotencyKey: String(translated.idempotency_key),
        ...actor,
      }, authorizeFolder(o.cards));
    }));
  },
  bulk_set_card_status: (o, a, c) => {
    const actor = maintenanceActor(a, c);
    return run(async () => {
      const service = await o.cards.cardServiceProvider!();
      const authorize = authorizeFolder(o.cards);
      const status = a.status as BulkSetCardStatusInput["status"];
      const reason = typeof a.reason === "string" ? a.reason : undefined;
      const idempotencyKey = String(a.idempotency_key);
      const results: BulkStatusItem[] = [];
      for (const input of Array.isArray(a.card_ids) ? a.card_ids.map(String) : []) {
        let cardId = input;
        try {
          cardId = await resolveBulkReference(o.cards, input);
          const { results: childResults } = await service.bulkSetCardStatus({ cardIds: [cardId], status, reason, idempotencyKey, ...actor }, authorize);
          results.push(childResults[0] ?? { card_id: cardId, ok: false, error: "카드 상태를 바꾸지 못했습니다." });
        } catch (error) {
          results.push({ card_id: cardId, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { results };
    });
  },
} satisfies Record<"update_unstarted_card" | "merge_cards" | "bulk_set_card_status", Handler>;

/** External callers never reach these tools through ingress, but keep the same 403 as other internal mutations. */
function maintenanceActor(args: Args, context: McpCallContext): MaintenanceActor {
  if (context.principal === "external")
    throw Object.assign(new Error("card mutation requires an agent session"), { statusCode: 403 });
  const authenticated = context.callerSessionId?.trim() ?? "";
  if (!authenticated)
    throw Object.assign(new Error("인증된 내부 에이전트 세션이 필요합니다."), { statusCode: 403 });
  const explicit = typeof args.caller_session_id === "string" ? args.caller_session_id.trim() : "";
  if (explicit && explicit !== authenticated)
    throw Object.assign(new Error("caller_session_id가 인증된 호출 세션과 다릅니다."), { statusCode: 403 });
  return { actorKind: "agent", actorSessionId: authenticated };
}

function translate(options: Options, args: Args, call: (translated: Args) => Promise<CallToolResult>) {
  return callWithReferenceTranslation(args, refs => lookupReferences(options, refs), call);
}

async function lookupReferences(options: Options, refs: string[]) {
  const [service, access, folders] = await Promise.all([
    options.cardServiceProvider!(), options.resolveAccess!(), options.provider.listFolders(),
  ]);
  const normalized = normalizeAccess(access);
  return service.resolveReferences(refs, folderId => isFolderAllowed(normalized, folders, folderId));
}

/** Bulk translates one input at a time so a single unresolved reference cannot abort the batch. */
async function resolveBulkReference(options: Options, input: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed.startsWith("#")) return trimmed;
  const [resolved] = await lookupReferences(options, [trimmed]);
  if (!resolved) throw new Error(`번호 참조를 해석하지 못했습니다: ${trimmed}`);
  if ("error" in resolved) throw new Error(resolved.error);
  if (resolved.kind !== "card")
    throw new Error(`card_ids에는 카드 번호(#412)를 적습니다. 받은 값: ${trimmed}`);
  return resolved.id;
}

function authorizeFolder(options: Options): AuthorizeFolder {
  return async folderId => {
    try {
      await allowed(options, options.resolveAccess, folderId);
    } catch (error) {
      if ((error as { code?: unknown }).code === "FOLDER_ACCESS_DENIED")
        throw Object.assign(new Error("카드가 속한 폴더에 접근할 수 없습니다."), { statusCode: 403, code: "FOLDER_ACCESS_DENIED" });
      throw error;
    }
  };
}

async function run(fn: () => Promise<unknown>) {
  try { return jsonResult(await fn()); }
  catch (error) { return errorResultFromError(error); }
}

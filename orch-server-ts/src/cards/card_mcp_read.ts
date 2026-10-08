import { z } from "zod";
import { serializeCardRow } from "../folders/folder_contracts.js";
import {
  CARD_MCP_READ_KINDS,
  CardMcpReadRepository,
  type CardMcpCursorPosition,
  type CardMcpListQuery,
  type CardMcpReadKind,
  type CardMcpSectionPage,
} from "./control_plane/card_mcp_read_repository.js";
import type { SqlClient } from "./control_plane/card_types.js";

const CARD_STATUSES = ["todo", "queued", "blocked", "running", "review", "done", "cancelled"] as const;
const TOKEN_FINGERPRINT_KINDS = [
  "card", "request", "brief", "attachments", "questions", "questions_history",
  "comments", "notes", "reports", "sessions", "now_history", "operation",
] as const;
const fingerprintKinds = new Set<string>(TOKEN_FINGERPRINT_KINDS);
const offsetCursorKinds = new Set<string>(["request", "brief", "attachments"]);

const listInputSchema = z.object({
  folder_id: z.string().min(1).optional(),
  status: z.enum(CARD_STATUSES).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).optional(),
  all: z.boolean().optional(),
}).strict();

const getInputSchema = z.object({
  include: z.array(z.enum(CARD_MCP_READ_KINDS)).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  text_limit: z.number().int().min(1).max(4000).optional(),
  cursors: z.record(z.string(), z.string().min(1)).optional(),
  since: z.string().min(1).optional(),
  operation_id: z.string().min(1).optional(),
}).strict();

export type CardMcpListInput = z.infer<typeof listInputSchema>;
export type CardMcpGetInput = z.infer<typeof getInputSchema>;
export type CardMcpListCard = {
  id: string;
  number: number | null;
  title: string;
  status: string;
  assigneeKind: string | null;
  assigneeAgentId: string | null;
  assigneeSessionId: string | null;
  assigneeUserId: string | null;
  updatedAt: string;
};
export interface CardMcpListResponse {
  cards: CardMcpListCard[];
  nextCursor: string | null;
  truncated: boolean;
}
export interface CardMcpGetResponse extends Record<string, unknown> {
  changeToken?: string;
}

type RecordCursor = { v: 1; type: "record"; cardId: string; kind: string; timestamp: string; id: string };
type OffsetCursor = { v: 1; type: "offset"; cardId: string; kind: string; offset: number };
type ListCursor = {
  v: 1; type: "list"; folderId: string | null; status: string | null; folder: string; positionKey: string; id: string;
};
type ChangeToken = {
  v: 1; dto: 1; cardId: string; fingerprints: Record<string, string>;
};

function httpError(statusCode: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}

function invalid(message: string): never {
  throw httpError(400, message, "INVALID_CARD_REQUEST");
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (!result.success) invalid(result.error.issues[0]?.message ?? "Invalid card request");
  return result.data;
}

function encodeOpaque(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeOpaque(value: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalid("Invalid card cursor or change token");
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) invalid("Invalid card cursor or change token");
    return JSON.parse(decoded) as unknown;
  } catch {
    return invalid("Invalid card cursor or change token");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseListCursor(raw: string, folderId: string | null, status: string | null): ListCursor {
  const value = decodeOpaque(raw);
  if (!isRecord(value)
    || value.v !== 1
    || value.type !== "list"
    || value.folderId !== folderId
    || value.status !== status
    || typeof value.folder !== "string"
    || typeof value.positionKey !== "string"
    || typeof value.id !== "string") {
    return invalid("Card list cursor does not match this query");
  }
  return value as ListCursor;
}

function encodeListCursor(folderId: string | null, status: string | null, row: {
  folder_id: string; position_key: string; id: string;
}): string {
  return encodeOpaque({
    v: 1, type: "list", folderId, status,
    folder: row.folder_id, positionKey: row.position_key, id: row.id,
  });
}

function parseSectionCursor(raw: string, cardId: string, kind: string): CardMcpCursorPosition {
  const value = decodeOpaque(raw);
  if (!isRecord(value) || value.v !== 1 || value.cardId !== cardId || value.kind !== kind)
    return invalid("Card section cursor does not match this card or section");
  if (offsetCursorKinds.has(kind)
    && value.type === "offset" && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0)
    return { offset: Number(value.offset) };
  if (!offsetCursorKinds.has(kind)
    && value.type === "record"
    && typeof value.id === "string" && value.id.length > 0
    && typeof value.timestamp === "string"
    && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::?\d{2})?$/.test(value.timestamp)
    && Number.isFinite(Date.parse(value.timestamp))) {
    return { timestamp: value.timestamp, id: value.id };
  }
  return invalid("Invalid card section cursor");
}

function encodeSectionCursor(cardId: string, kind: string, cursor: CardMcpCursorPosition): string {
  return encodeOpaque("offset" in cursor
    ? { v: 1, type: "offset", cardId, kind, offset: cursor.offset }
    : { v: 1, type: "record", cardId, kind, timestamp: cursor.timestamp, id: cursor.id });
}

function decodeChangeToken(raw: string, cardId: string): ChangeToken {
  const value = decodeOpaque(raw);
  if (!isRecord(value) || value.v !== 1 || value.dto !== 1 || value.cardId !== cardId || !isRecord(value.fingerprints))
    return invalid("Change token does not match this card or DTO version");
  const fingerprints = value.fingerprints;
  const keys = Object.keys(fingerprints);
  if (keys.length !== TOKEN_FINGERPRINT_KINDS.length
    || TOKEN_FINGERPRINT_KINDS.some((kind) => !Object.hasOwn(fingerprints, kind))
    || keys.some((kind) => !fingerprintKinds.has(kind))
    || keys.some((kind) => typeof fingerprints[kind] !== "string" || !/^[a-f0-9]{32}$/.test(fingerprints[kind] as string))) {
    return invalid("Invalid card change token");
  }
  return value as ChangeToken;
}

function createChangeToken(cardId: string, fingerprints: Record<string, string>): string {
  return encodeOpaque({ v: 1, dto: 1, cardId, fingerprints });
}

function changedKinds(previous: ChangeToken, current: Record<string, string>): string[] {
  return TOKEN_FINGERPRINT_KINDS.filter((kind) => previous.fingerprints[kind] !== current[kind]);
}

function serializePage(
  kind: CardMcpReadKind,
  page: CardMcpSectionPage,
  cardId: string,
  replace: boolean,
): Record<string, unknown> {
  if (page.kind === "text") {
    return {
      text: page.text,
      nextCursor: page.nextOffset === null ? null : encodeSectionCursor(cardId, kind, { offset: page.nextOffset }),
      truncated: page.truncated,
      ...(replace ? { replace: true } : {}),
    };
  }
  const items = kind === "attachments"
    ? page.items
    : kind === "now_history"
      ? page.items.map((row) => ({
          id: row.id,
          text: row.text,
          turn: row.turn,
          ask: row.ask ?? null,
          at: row.at instanceof Date ? row.at.toISOString() : row.at,
        }))
      : page.items.map((row) => serializeCardRow(row));
  return {
    items,
    nextCursor: page.next === null ? null : encodeSectionCursor(cardId, kind, page.next),
    truncated: page.truncated,
    ...(replace ? { replace: true } : {}),
  };
}

export class CardMcpReadService {
  private readonly repository: CardMcpReadRepository;

  constructor(sql: SqlClient) {
    this.repository = new CardMcpReadRepository(sql);
  }

  async listCards(input: CardMcpListInput, allowedFolderIds: readonly string[] | null): Promise<CardMcpListResponse> {
    const parsed = parseInput(listInputSchema, input);
    const folderId = parsed.folder_id ?? null;
    const status = parsed.status ?? null;
    const all = parsed.all === true;
    if (all && (parsed.limit !== undefined || parsed.cursor !== undefined))
      invalid("all cannot be combined with limit or cursor");
    const limit = parsed.limit ?? 20;
    const after = parsed.cursor ? parseListCursor(parsed.cursor, folderId, status) : null;
    const query: CardMcpListQuery = {
      folderId, status, all, limit, allowedFolderIds,
      after: after ? { folderId: after.folder, positionKey: after.positionKey, id: after.id } : null,
    };
    const result = await this.repository.listCards(query);
    const cards = result.rows.map((row) => serializeCardRow({
      id: row.id, number: row.number, title: row.title, status: row.status,
      assignee_kind: row.assignee_kind, assignee_agent_id: row.assignee_agent_id,
      assignee_session_id: row.assignee_session_id, assignee_user_id: row.assignee_user_id, updated_at: row.updated_at,
    }) as CardMcpListCard);
    const last = result.rows.at(-1);
    return {
      cards,
      nextCursor: result.truncated && last ? encodeListCursor(folderId, status, last) : null,
      truncated: result.truncated,
    };
  }

  async getCard(
    cardId: string,
    input: CardMcpGetInput,
    allowedFolderIds: readonly string[] | null,
  ): Promise<CardMcpGetResponse> {
    const parsed = parseInput(getInputSchema, input);
    const include = parsed.include ?? [];
    const selected = new Set(include);
    if (selected.size !== include.length) invalid("include contains duplicate sections");
    if (parsed.since !== undefined && (parsed.cursors !== undefined || parsed.operation_id !== undefined))
      invalid("since cannot be combined with cursors or operation_id");
    if (parsed.operation_id !== undefined && parsed.cursors !== undefined)
      invalid("operation_id cannot be combined with cursors");
    for (const kind of Object.keys(parsed.cursors ?? {})) {
      if (kind !== "questions" && !selected.has(kind as CardMcpReadKind))
        invalid("A cursor was provided for a section that was not selected");
    }

    const limit = parsed.limit ?? 20;
    const textLimit = parsed.text_limit ?? 4000;
    const sectionCursors = new Map<string, CardMcpCursorPosition>();
    for (const [kind, cursor] of Object.entries(parsed.cursors ?? {})) {
      sectionCursors.set(kind, parseSectionCursor(cursor, cardId, kind));
    }

    return this.repository.withCardSnapshot(cardId, allowedFolderIds, async ({ sql, current }) => {
      const changeToken = createChangeToken(cardId, current.fingerprints);
      const previous = parsed.since ? decodeChangeToken(parsed.since, cardId) : null;
      const changed = previous ? changedKinds(previous, current.fingerprints) : null;
      if (previous && changed?.length === 0) return { id: cardId, unchanged: true, changeToken };

      const result: Record<string, unknown> = {};
      if (previous) {
        result.id = cardId;
        result.unchanged = false;
        result.changed = changed;
        result.available = current.available;
        if (changed?.includes("card")) result.card = serializeCardRow(current.card);
      } else {
        result.card = serializeCardRow(current.card);
        result.available = current.available;
      }
      result.changeToken = changeToken;

      const shouldReadQuestions = previous === null || changed?.includes("questions") === true;
      if (shouldReadQuestions) {
        const cursor = sectionCursors.get("questions");
        const page = await this.repository.readQuestionPage(
          sql, cardId, limit, cursor && "timestamp" in cursor ? cursor : null,
        );
        if (page.kind !== "items") throw new Error("Question query returned a text page");
        result.questions = {
          items: page.items.map((row) => serializeCardRow(row)),
          nextCursor: page.next === null ? null : encodeSectionCursor(cardId, "questions", page.next),
          truncated: page.truncated,
          ...(previous ? { replace: true } : {}),
        };
      }

      const sectionResults: Record<string, unknown> = {};
      for (const kind of include) {
        if (previous && !changed?.includes(kind)) continue;
        const cursor = sectionCursors.get(kind) ?? null;
        const page = await this.repository.readSectionPage(sql, cardId, kind, limit, textLimit, cursor);
        sectionResults[kind] = serializePage(kind, page, cardId, previous !== null);
      }
      if (Object.keys(sectionResults).length > 0) result.sections = sectionResults;

      if (parsed.operation_id !== undefined) {
        const operation = await this.repository.readOperation(sql, cardId, parsed.operation_id);
        if (!operation) throw httpError(404, "Card operation not found");
        result.operation = serializeCardRow({
          id: operation.id,
          operation_type: operation.operation_type,
          created_at: operation.created_at,
          item_id: operation.item_id ?? null,
          report_id: operation.report_id ?? null,
          question_id: operation.question_id ?? null,
          verification: operation.verification ?? null,
          summary: operation.summary ?? null,
        });
      }
      return result;
    });
  }
}

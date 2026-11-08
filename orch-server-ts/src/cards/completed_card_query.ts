import { z } from "zod";

const instant = z.string().datetime({ offset: true });
const querySchema = z.object({
  folderId: z.string().optional(), status: z.string().optional(),
  includeCompleted: z.enum(["true", "false"]).optional(),
  includeClosed: z.enum(["true", "false"]).optional(),
  completedFrom: instant.optional(), completedBefore: instant.optional(), q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(60), cursor: z.string().optional(),
});
// Preserve PostgreSQL microseconds in cursors; JavaScript Date rounds them away.
const cursorSchema = z.object({ time: z.string().min(1).refine(value => Number.isFinite(Date.parse(value))), id: z.string().min(1) });
const pagedCursorSchema = z.object({
  rank: z.number().int().min(1).max(9),
  time: z.string().min(1).refine(value => Number.isFinite(Date.parse(value))),
  id: z.string().min(1),
});
export type CompletedCardQuery = {
  folderId?: string; allowedFolderIds?: readonly string[] | null;
  completedFrom?: string; completedBefore?: string; q?: string; limit: number;
  after?: { time: string; id: string };
};
export type PagedCardQuery = {
  folderId?: string; status?: string; includeClosed: boolean; allowedFolderIds?: readonly string[] | null;
  q?: string; limit: number; after?: { rank: number; time: string; id: string };
};
export function parseCardQuery(input: unknown) {
  try {
    const raw = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
    const parsed = querySchema.parse(input);
    const paged = parsed.status !== "done"
      && (raw.includeClosed !== undefined || raw.limit !== undefined || raw.cursor !== undefined);
    const after = parsed.cursor && parsed.status === "done"
      ? cursorSchema.parse(JSON.parse(Buffer.from(parsed.cursor, "base64url").toString("utf8"))) : undefined;
    const pagedAfter = parsed.cursor && parsed.status !== "done"
      ? pagedCursorSchema.parse(JSON.parse(Buffer.from(parsed.cursor, "base64url").toString("utf8"))) : undefined;
    return {
      ...parsed, paged,
      includeClosed: parsed.includeClosed !== "false" && parsed.includeCompleted !== "false",
      includeCompleted: parsed.includeCompleted !== "false",
      after, pagedAfter,
    };
  } catch {
    throw Object.assign(new Error("Invalid card query"), { statusCode: 400, code: "INVALID_CARD_QUERY" });
  }
}
export function completedCardCursor(time: string, id: string) {
  return Buffer.from(JSON.stringify({ time, id }), "utf8").toString("base64url");
}
export function pagedCardCursor(rank: number, time: string, id: string) {
  return Buffer.from(JSON.stringify({ rank, time, id }), "utf8").toString("base64url");
}

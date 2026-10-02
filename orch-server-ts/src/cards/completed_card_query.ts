import { z } from "zod";

const instant = z.string().datetime({ offset: true });
const querySchema = z.object({
  folderId: z.string().optional(), status: z.string().optional(),
  includeCompleted: z.enum(["true", "false"]).optional(),
  completedFrom: instant.optional(), completedBefore: instant.optional(), q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(60), cursor: z.string().optional(),
});
// Preserve PostgreSQL microseconds in cursors; JavaScript Date rounds them away.
const cursorSchema = z.object({ time: z.string().min(1).refine(value => Number.isFinite(Date.parse(value))), id: z.string().min(1) });
export type CompletedCardQuery = {
  folderId?: string; allowedFolderIds?: readonly string[] | null;
  completedFrom?: string; completedBefore?: string; q?: string; limit: number;
  after?: { time: string; id: string };
};
export function parseCardQuery(input: unknown) {
  try {
    const parsed = querySchema.parse(input);
    const after = parsed.cursor ? cursorSchema.parse(JSON.parse(Buffer.from(parsed.cursor, "base64url").toString("utf8"))) : undefined;
    return { ...parsed, includeCompleted: parsed.includeCompleted !== "false", after };
  } catch {
    throw Object.assign(new Error("Invalid card query"), { statusCode: 400, code: "INVALID_CARD_QUERY" });
  }
}
export function completedCardCursor(time: string, id: string) {
  return Buffer.from(JSON.stringify({ time, id }), "utf8").toString("base64url");
}

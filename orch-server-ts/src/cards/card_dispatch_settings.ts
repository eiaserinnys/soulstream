import { z } from "zod";
import type { SqlClient } from "./control_plane/card_types.js";

const concurrencySchema = z.record(z.string().min(1), z.number().int().nonnegative())
  .refine(value => Object.hasOwn(value, "default"), "nodeConcurrency.default is required");
export type CardDispatchSettings = {
  key: "card_dispatch"; nodeConcurrency: Record<string, number> & { default: number };
  version: number; updatedAt: string; updatedBy: string;
};
type Row = { value: unknown; version: number; updated_at: Date; updated_by: string };
export class CardDispatchSettingsError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}
export async function readCardDispatchSettings(sql: SqlClient): Promise<CardDispatchSettings> {
  const rows = await sql<Row[]>`SELECT value,version,updated_at,updated_by FROM system_settings WHERE setting_key='card_dispatch'`;
  if (!rows[0]) throw new CardDispatchSettingsError(503,"CARD_DISPATCH_UNAVAILABLE","card_dispatch seed is missing");
  return parseRow(rows[0]);
}
export async function updateCardDispatchSettings(sql: SqlClient, input: {
  nodeConcurrency: unknown; expectedVersion: number; updatedBy: string;
}): Promise<CardDispatchSettings> {
  const parsed = concurrencySchema.safeParse(input.nodeConcurrency);
  if (!parsed.success || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion<1 || !input.updatedBy.trim()) {
    throw new CardDispatchSettingsError(422,"CARD_DISPATCH_INVALID","Expected nodeConcurrency with non-negative integer values and default, positive expectedVersion and updatedBy");
  }
  const rows = await sql<Row[]>`UPDATE system_settings SET value=${sql.json({nodeConcurrency:parsed.data})},
    version=version+1,updated_at=NOW(),updated_by=${input.updatedBy.trim().toLowerCase()}
    WHERE setting_key='card_dispatch' AND version=${input.expectedVersion} RETURNING value,version,updated_at,updated_by`;
  if (rows[0]) return parseRow(rows[0]);
  const current = await readCardDispatchSettings(sql);
  throw new CardDispatchSettingsError(409,"CARD_DISPATCH_CONFLICT",`card_dispatch changed from version ${input.expectedVersion} to ${current.version}. Reload before saving.`);
}
function parseRow(row: Row): CardDispatchSettings {
  const parsed = z.object({nodeConcurrency:concurrencySchema}).safeParse(row.value);
  if (!parsed.success) throw new CardDispatchSettingsError(503,"CARD_DISPATCH_UNAVAILABLE","Stored card_dispatch is invalid");
  return {key:"card_dispatch",nodeConcurrency:parsed.data.nodeConcurrency as CardDispatchSettings["nodeConcurrency"],version:row.version,
    updatedAt:new Date(row.updated_at).toISOString(),updatedBy:row.updated_by};
}

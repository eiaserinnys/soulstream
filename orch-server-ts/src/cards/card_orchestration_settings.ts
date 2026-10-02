import {
  parseOrchestrationPolicy,
  type OrchestrationSettings,
} from "@soulstream/wire-schema/card-orchestration";
import type { SqlClient } from "./control_plane/card_types.js";
export type { OrchestrationSettings };
type Row = {
  value: unknown;
  version: unknown;
  updated_at: Date;
  updated_by: string;
};
export class CardOrchestrationSettingsError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function readCardOrchestrationSettings(
  sql: SqlClient,
): Promise<OrchestrationSettings> {
  const rows = await sql<
    Row[]
  >`SELECT value,version,updated_at,updated_by FROM system_settings WHERE setting_key='card_orchestration'`;
  if (!rows[0])
    throw new CardOrchestrationSettingsError(
      503,
      "CARD_ORCHESTRATION_UNAVAILABLE",
      "card_orchestration migration is missing",
    );
  return parseRow(rows[0]);
}
export async function updateCardOrchestrationSettings(
  sql: SqlClient,
  input: { policy: unknown; expectedVersion: number; updatedBy: string },
): Promise<OrchestrationSettings> {
  let policy: OrchestrationSettings["policy"];
  try {
    policy = parseOrchestrationPolicy(input.policy);
  } catch (error) {
    throw new CardOrchestrationSettingsError(
      422,
      "CARD_ORCHESTRATION_INVALID",
      String(error),
    );
  }
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    !input.updatedBy.trim()
  )
    throw new CardOrchestrationSettingsError(
      422,
      "CARD_ORCHESTRATION_INVALID",
      "positive expectedVersion and verified updatedBy are required",
    );
  const rows = await sql<
    Row[]
  >`UPDATE system_settings SET value=${sql.json(policy)},version=version+1,updated_at=NOW(),updated_by=${input.updatedBy.trim().toLowerCase()} WHERE setting_key='card_orchestration' AND version=${input.expectedVersion} RETURNING value,version,updated_at,updated_by`;
  if (rows[0]) return parseRow(rows[0]);
  const current = await readCardOrchestrationSettings(sql);
  throw new CardOrchestrationSettingsError(
    409,
    "CARD_ORCHESTRATION_CONFLICT",
    `Policy changed from version ${input.expectedVersion} to ${current.version}. Reload before saving.`,
  );
}
function parseRow(row: Row): OrchestrationSettings {
  try {
    return {
      key: "card_orchestration",
      policy: parseOrchestrationPolicy(row.value),
      version: parseCardOrchestrationVersion(row.version),
      updatedAt: new Date(row.updated_at).toISOString(),
      updatedBy: row.updated_by,
    };
  } catch {
    throw new CardOrchestrationSettingsError(
      503,
      "CARD_ORCHESTRATION_UNAVAILABLE",
      "Stored card_orchestration policy is invalid",
    );
  }
}

export function parseCardOrchestrationVersion(value: unknown): number {
  const version =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9]\d*$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1)
    throw new TypeError(
      "card_orchestration version must be a positive safe integer",
    );
  return version;
}

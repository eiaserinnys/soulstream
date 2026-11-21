import type { SqlClient } from "../control_plane_types.js";

export function normalizedInputTokens(sql: SqlClient) {
  const codexValue = numberField(sql, "usage", "input_tokens");
  const claudeFields = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
  const hasInvalidValue = claudeFields.map((field) =>
    sql`(usage ? ${field} AND jsonb_typeof(usage->${field}) <> 'number')`
  );
  const hasNumericValue = claudeFields.map((field) =>
    sql`jsonb_typeof(usage->${field}) = 'number'`
  );
  const fieldValues = claudeFields.map((field) =>
    sql`coalesce(${numberField(sql, "usage", field)}, 0)`
  );
  return sql`
    CASE WHEN usage ? 'cached_input_tokens' THEN ${codexValue}
      WHEN ${hasInvalidValue[0]} OR ${hasInvalidValue[1]} OR ${hasInvalidValue[2]} THEN NULL
      WHEN ${hasNumericValue[0]} OR ${hasNumericValue[1]} OR ${hasNumericValue[2]}
        THEN ${fieldValues[0]} + ${fieldValues[1]} + ${fieldValues[2]}
      ELSE NULL
    END
  `;
}

export function numberField(sql: SqlClient, object: "usage" | "first_call", field: string) {
  const source = object === "usage" ? sql`usage` : sql`first_call`;
  return sql`CASE WHEN jsonb_typeof(${source}->${field}) = 'number'
    THEN (${source}->>${field})::numeric END`;
}

export function asNumber(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

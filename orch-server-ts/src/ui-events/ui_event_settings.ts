import type { SqlClient } from "../control_plane/control_plane_types.js";

export const UI_EVENT_COLLECTION_SETTING_KEY = "ui_event_collection";

export type UiEventCollectionConfig = {
  readonly enabled: boolean;
  readonly flushIntervalMs: number;
  readonly maxBatchSize: number;
  readonly maxQueueSize: number;
};

/**
 * 설정을 읽지 못했을 때의 값. **fail-closed** — 저장소가 말이 없으면 수집하지 않는다.
 * 정상 기본값은 코드가 아니라 migration 092의 seed가 정본이다.
 */
export const UI_EVENT_COLLECTION_DISABLED: UiEventCollectionConfig = {
  enabled: false,
  flushIntervalMs: 10_000,
  maxBatchSize: 20,
  maxQueueSize: 500,
};

/**
 * `system_settings`의 `ui_event_collection` 행을 읽는다.
 *
 * 행이 없거나 저장소가 아직 없으면(마이그레이션 미적용) 예외를 던지지 않고
 * 비활성 설정을 돌려준다. 설정 조회 실패가 대시보드를 망가뜨릴 이유는 없다.
 */
export async function readUiEventCollectionConfig(
  sql: SqlClient,
): Promise<UiEventCollectionConfig> {
  let rows: readonly Record<string, unknown>[];
  try {
    rows = await sql`
      SELECT value
      FROM system_settings
      WHERE setting_key = ${UI_EVENT_COLLECTION_SETTING_KEY}
    `;
  } catch {
    return UI_EVENT_COLLECTION_DISABLED;
  }
  const value = rows[0]?.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return UI_EVENT_COLLECTION_DISABLED;
  }
  const record = value as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    flushIntervalMs: boundedInteger(record.flushIntervalMs, 1_000, 600_000, 10_000),
    maxBatchSize: boundedInteger(record.maxBatchSize, 1, 50, 20),
    maxQueueSize: boundedInteger(record.maxQueueSize, 10, 5_000, 500),
  };
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isSafeInteger(value)) return fallback;
  const numeric = value as number;
  if (numeric < min) return min;
  if (numeric > max) return max;
  return numeric;
}

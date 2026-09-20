import type { SqlClient } from "../control_plane/control_plane_types.js";
import type {
  StoredUiEvent,
  UiEventInstall,
  UiEventQuery,
  UiEventRepository,
  UiEventRow,
} from "../ui-events/ui_event_routes.js";
import type { UiEventClientKind, UiEventEntry, UiEventTargetKind, UiEventType }
  from "../ui-events/ui_event_contract.js";
import { readUiEventCollectionConfig } from "../ui-events/ui_event_settings.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";

export type CreateLiveUiEventRepositoryOptions = {
  readonly sqlResolver: LiveDbSqlResolver;
};

/** 원시 이벤트 보존 기간. 활동이 있을 때만 정리되는 대략적 정책이다. */
const RETENTION_DAYS = 30;

/** 한 번의 정리에서 지우는 행 수 상한. 밀린 분량은 여러 번에 걸쳐 빠진다. */
const PRUNE_BATCH_LIMIT = 5000;

export function createLiveUiEventRepository(
  options: CreateLiveUiEventRepositoryOptions,
): UiEventRepository {
  const sqlClient = async (): Promise<SqlClient> =>
    (await options.sqlResolver.resolveSql()) as unknown as SqlClient;

  return {
    async readConfig() {
      return readUiEventCollectionConfig(await sqlClient());
    },

    async insertBatch(rows: readonly UiEventRow[]) {
      if (rows.length === 0) return [];
      const sql = await sqlClient();
      // 한 문장으로 전부 넣고, 이미 있는 event_id는 조용히 넘긴다.
      // RETURNING이 실제로 저장된 것만 돌려주므로 중복 수를 셀 수 있다.
      const values = rows.map((row) => ({
        event_id: row.eventId,
        schema_version: row.schemaVersion,
        user_email: row.userEmail,
        client_kind: row.clientKind,
        install_id: row.installId,
        client_session_key: row.clientSessionKey,
        seq: row.seq,
        app_version: row.appVersion,
        event_type: row.type,
        target_kind: row.targetKind,
        target_id: row.targetId,
        from_kind: row.fromKind,
        from_id: row.fromId,
        entry: row.entry,
        flow_id: row.flowId,
        attrs: sql.json(row.attrs) as unknown,
        occurred_at: row.occurredAt,
      }));
      const inserted = await sql`
        INSERT INTO ui_events ${sql(
          values,
          "event_id",
          "schema_version",
          "user_email",
          "client_kind",
          "install_id",
          "client_session_key",
          "seq",
          "app_version",
          "event_type",
          "target_kind",
          "target_id",
          "from_kind",
          "from_id",
          "entry",
          "flow_id",
          "attrs",
          "occurred_at",
        )}
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id
      `;
      return inserted.flatMap((row) => {
        const id = row.event_id ?? row.eventId;
        return typeof id === "string" ? [id] : [];
      });
    },

    async query(query: UiEventQuery) {
      const sql = await sqlClient();
      // user_email은 호출자 신원에서만 오고 절대 파라미터로 열지 않는다.
      const rows = await sql`
        SELECT event_id, seq, occurred_at, received_at, client_kind, install_id,
               client_session_key, app_version, event_type, target_kind, target_id,
               from_kind, from_id, entry, flow_id, attrs
        FROM ui_events
        WHERE user_email = ${query.userEmail}
          AND occurred_at >= ${query.from}
          AND occurred_at <= ${query.to}
          AND (${query.installId ?? null}::TEXT IS NULL OR install_id = ${query.installId ?? null})
          AND (${query.clientKind ?? null}::TEXT IS NULL OR client_kind = ${query.clientKind ?? null})
          AND (${query.targetKind ?? null}::TEXT IS NULL OR target_kind = ${query.targetKind ?? null})
          AND (${query.targetId ?? null}::TEXT IS NULL OR target_id = ${query.targetId ?? null})
          AND (
            ${query.cursorOccurredAt ?? null}::TIMESTAMPTZ IS NULL
            OR (occurred_at, event_id::TEXT)
               > (${query.cursorOccurredAt ?? null}::TIMESTAMPTZ, ${query.cursorEventId ?? ""}::TEXT)
          )
        ORDER BY occurred_at ASC, event_id ASC
        LIMIT ${query.limit}
      `;
      return rows.map(toStoredUiEvent);
    },

    async listInstalls(query) {
      const sql = await sqlClient();
      const rows = await sql`
        SELECT install_id,
               client_kind,
               MAX(app_version)   AS app_version,
               MIN(occurred_at)   AS first_seen,
               MAX(occurred_at)   AS last_seen,
               COUNT(*)::BIGINT   AS event_count
        FROM ui_events
        WHERE user_email = ${query.userEmail}
          AND occurred_at >= ${query.from}
          AND occurred_at <= ${query.to}
        GROUP BY install_id, client_kind
        ORDER BY MAX(occurred_at) DESC
      `;
      return rows.map((row): UiEventInstall => ({
        installId: text(row.install_id),
        clientKind: text(row.client_kind) as UiEventClientKind,
        appVersion: text(row.app_version),
        firstSeen: timestamp(row.first_seen),
        lastSeen: timestamp(row.last_seen),
        eventCount: Number(row.event_count ?? 0),
      }));
    },

    async pruneExpired() {
      const sql = await sqlClient();
      const deleted = await sql`
        DELETE FROM ui_events
        WHERE event_id IN (
          SELECT event_id
          FROM ui_events
          WHERE received_at < NOW() - ${`${RETENTION_DAYS} days`}::INTERVAL
          LIMIT ${PRUNE_BATCH_LIMIT}
        )
        RETURNING event_id
      `;
      return deleted.length;
    },
  };
}

function toStoredUiEvent(row: Record<string, unknown>): StoredUiEvent {
  const targetKind = optionalText(row.target_kind);
  const fromKind = optionalText(row.from_kind);
  const entry = optionalText(row.entry);
  return {
    eventId: text(row.event_id),
    seq: Number(row.seq ?? 0),
    occurredAt: timestamp(row.occurred_at),
    receivedAt: timestamp(row.received_at),
    clientKind: text(row.client_kind) as UiEventClientKind,
    installId: text(row.install_id),
    clientSessionKey: text(row.client_session_key),
    appVersion: text(row.app_version),
    type: text(row.event_type) as UiEventType,
    target: targetKind === undefined
      ? null
      : { kind: targetKind as UiEventTargetKind, id: text(row.target_id) },
    from: fromKind === undefined
      ? null
      : { kind: fromKind as UiEventTargetKind, id: text(row.from_id) },
    entry: entry === undefined ? null : (entry as UiEventEntry),
    flowId: optionalText(row.flow_id) ?? null,
    attrs: isRecord(row.attrs) ? row.attrs : {},
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

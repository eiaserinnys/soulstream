import type postgres from "postgres";

export async function createPre086Fixture(
  sql: ReturnType<typeof postgres>,
): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      termination_reason TEXT,
      termination_detail TEXT,
      review_state TEXT NOT NULL,
      last_assistant_text TEXT,
      termination_event_id INTEGER,
      execution_registration_id TEXT,
      execution_command_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL,
      last_event_id INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE session_deliveries (
      delivery_id TEXT PRIMARY KEY,
      source_session_id TEXT,
      target_session_id TEXT NOT NULL,
      intent TEXT NOT NULL,
      source TEXT,
      producer_kind TEXT,
      producer_terminal_revision TEXT,
      state TEXT NOT NULL,
      aggregate_state TEXT NOT NULL DEFAULT 'pending',
      consumed_at TIMESTAMPTZ,
      consumed_reason TEXT,
      superseded_at TIMESTAMPTZ,
      superseded_terminal_revision TEXT,
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE session_delivery_notification_outbox (
      delivery_id TEXT PRIMARY KEY REFERENCES session_deliveries(delivery_id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      projection_state TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      last_error TEXT,
      dead_lettered_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE session_delivery_attempts (
      delivery_id TEXT NOT NULL REFERENCES session_deliveries(delivery_id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL,
      lease_owner TEXT,
      PRIMARY KEY (delivery_id, attempt_number)
    );
    CREATE INDEX idx_session_deliveries_recovery
      ON session_deliveries(state, lease_expires_at, updated_at);
    CREATE INDEX idx_session_delivery_notification_recovery
      ON session_delivery_notification_outbox(state, lease_expires_at, updated_at);
    CREATE FUNCTION session_discard_notification_projection_on_consumed()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER trg_session_discard_notification_projection
    AFTER UPDATE OF aggregate_state ON session_deliveries
    FOR EACH ROW
    EXECUTE FUNCTION session_discard_notification_projection_on_consumed();

    CREATE FUNCTION session_apply_running_transition(
      p_session_id TEXT, p_review_state TEXT, p_expected_terminal_event_id INTEGER,
      p_terminal_resume BOOLEAN, p_updated_at TIMESTAMPTZ
    ) RETURNS TABLE (
      applied BOOLEAN, status TEXT, termination_reason TEXT,
      termination_detail TEXT, review_state TEXT, last_assistant_text TEXT,
      termination_event_id INTEGER, updated_at TIMESTAMPTZ, last_event_id INTEGER
    ) LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE sessions SET status = 'running' WHERE session_id = p_session_id;
      UPDATE session_deliveries SET lease_owner = NULL, lease_expires_at = NULL
      WHERE source_session_id = p_session_id;
      RETURN QUERY SELECT TRUE, session.status, session.termination_reason,
        session.termination_detail, session.review_state, session.last_assistant_text,
        session.termination_event_id, session.updated_at, session.last_event_id
      FROM sessions AS session WHERE session.session_id = p_session_id;
    END;
    $$;

    CREATE FUNCTION session_record_execution_registration(
      p_session_id TEXT, p_registration_id TEXT, p_execution_command_id TEXT,
      p_review_state TEXT, p_expected_terminal_event_id INTEGER,
      p_terminal_resume BOOLEAN, p_recorded_at TIMESTAMPTZ
    ) RETURNS TABLE (
      applied BOOLEAN, execution_registration_id TEXT, execution_command_id TEXT,
      status TEXT, termination_reason TEXT, termination_detail TEXT,
      review_state TEXT, last_assistant_text TEXT, termination_event_id INTEGER,
      updated_at TIMESTAMPTZ, last_event_id INTEGER
    ) LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE sessions SET status = 'running' WHERE session_id = p_session_id;
      UPDATE session_deliveries SET lease_owner = NULL, lease_expires_at = NULL
      WHERE source_session_id = p_session_id;
      RETURN QUERY SELECT TRUE, session.execution_registration_id,
        session.execution_command_id, session.status, session.termination_reason,
        session.termination_detail, session.review_state, session.last_assistant_text,
        session.termination_event_id, session.updated_at, session.last_event_id
      FROM sessions AS session WHERE session.session_id = p_session_id;
    END;
    $$;

    INSERT INTO session_deliveries (
      delivery_id, target_session_id, intent, state, aggregate_state,
      lease_owner, lease_expires_at
    ) VALUES (
      'delivery-1', 'target-1', 'completion_notification', 'claimed', 'pending',
      'delivery-token', '2030-01-01T00:00:00.000Z'
    );
    INSERT INTO session_delivery_notification_outbox (
      delivery_id, state, projection_state, lease_owner, lease_expires_at
    ) VALUES (
      'delivery-1', 'claimed', 'publishing',
      'notification-token', '2030-01-02T00:00:00.000Z'
    );
    INSERT INTO session_delivery_attempts (delivery_id, attempt_number, lease_owner)
    VALUES ('delivery-1', 1, 'attempt-token');
  `);
}

export async function readSentinelRows(
  sql: ReturnType<typeof postgres>,
  schema: string,
): Promise<Record<string, Record<string, unknown>>> {
  await sql.unsafe(`SET search_path TO ${schema}`);
  const [delivery] = await sql<Array<Record<string, unknown>>>`
    SELECT attempt_token, attempt_expires_at FROM session_deliveries
    WHERE delivery_id = 'delivery-1'
  `;
  const [notification] = await sql<Array<Record<string, unknown>>>`
    SELECT attempt_token, attempt_expires_at FROM session_delivery_notification_outbox
    WHERE delivery_id = 'delivery-1'
  `;
  const [attempt] = await sql<Array<Record<string, unknown>>>`
    SELECT attempt_token FROM session_delivery_attempts
    WHERE delivery_id = 'delivery-1' AND attempt_number = 1
  `;
  return { delivery, notification, attempt } as Record<string, Record<string, unknown>>;
}

export async function readAttemptColumnShape(
  sql: ReturnType<typeof postgres>,
  schema: string,
): Promise<Array<Record<string, unknown>>> {
  return await sql<Array<Record<string, unknown>>>`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = ${schema}
      AND (
        (table_name = 'session_deliveries'
          AND column_name IN ('attempt_token', 'attempt_expires_at'))
        OR (table_name = 'session_delivery_notification_outbox'
          AND column_name IN ('attempt_token', 'attempt_expires_at'))
        OR (table_name = 'session_delivery_attempts'
          AND column_name = 'attempt_token')
      )
    ORDER BY table_name, column_name
  `;
}

export async function readFunctionBodies(
  sql: ReturnType<typeof postgres>,
  schema: string,
): Promise<Array<Record<string, unknown>>> {
  return await sql<Array<Record<string, unknown>>>`
    SELECT routine_name, routine_definition
    FROM information_schema.routines
    WHERE routine_schema = ${schema}
      AND routine_name IN (
        'session_record_execution_registration',
        'session_apply_running_transition',
        'session_discard_notification_projection_on_consumed'
      )
    ORDER BY routine_name
  `;
}

export async function readSupersededDelivery(
  sql: ReturnType<typeof postgres>,
): Promise<Record<string, unknown>> {
  const [delivery] = await sql<Array<Record<string, unknown>>>`
    SELECT aggregate_state, attempt_token, attempt_expires_at
    FROM session_deliveries
    WHERE delivery_id = 'delivery-1'
  `;
  return delivery;
}

export class LabDeliveryRuntime {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async forceDue(deliveryId) {
    assertIdentifier(deliveryId, "delivery id");
    return await this.runtime.psqlOne(`
      WITH updated AS (
        UPDATE session_deliveries SET next_attempt_at = NOW() - INTERVAL '1 second'
        WHERE delivery_id = ${sqlLiteral(deliveryId)}
          AND aggregate_state = 'pending'
        RETURNING delivery_id, attempt_count, state, aggregate_state
      ) SELECT row_to_json(updated) FROM updated
    `);
  }

  async seed(seed, options = {}) {
    assertIdentifier(seed.deliveryId, "delivery id");
    assertIdentifier(seed.sessionId, "session id");
    assertIdentifier(seed.completionId, "completion id");
    assertIdentifier(seed.relationKey, "relation key");
    const state = options.state ?? "pending";
    const aggregateState = options.aggregateState ?? "pending";
    const allowedStates = new Set(["pending", "claimed", "queued", "uncertain"]);
    if (!allowedStates.has(state)) throw new Error(`unsafe seeded delivery state: ${state}`);
    if (aggregateState !== "pending") {
      throw new Error(`unsafe seeded aggregate state: ${aggregateState}`);
    }
    const attemptCount = options.attemptCount ?? 0;
    const nextAttemptDelaySeconds = options.nextAttemptDelaySeconds ?? 0;
    if (!Number.isInteger(attemptCount) || attemptCount < 0) {
      throw new Error("seeded attempt count must be a non-negative integer");
    }
    if (!Number.isInteger(nextAttemptDelaySeconds) || nextAttemptDelaySeconds < 0) {
      throw new Error("seeded retry delay must be a non-negative integer");
    }
    const leaseOwner = options.leaseOwner ?? null;
    if (leaseOwner !== null) assertIdentifier(leaseOwner, "lease owner");
    return await this.runtime.psqlOne(`
      WITH inserted AS (
        INSERT INTO session_deliveries (
          delivery_id, target_session_id, relation_key, completion_id,
          intent, source, payload_hash, payload, state, aggregate_state,
          attempt_count, next_attempt_at, lease_owner, lease_expires_at,
          claimed_at, created_at, updated_at
        ) VALUES (
          ${sqlLiteral(seed.deliveryId)}, ${sqlLiteral(seed.sessionId)},
          ${sqlLiteral(seed.relationKey)}, ${sqlLiteral(seed.completionId)},
          'durable_next_turn', ${sqlLiteral(seed.source)},
          ${sqlLiteral(seed.payloadHash)}, ${sqlText(JSON.stringify(seed.payload))}::jsonb,
          ${sqlLiteral(state)}, ${sqlLiteral(aggregateState)}, ${attemptCount},
          NOW() + (${nextAttemptDelaySeconds} * INTERVAL '1 second'),
          ${leaseOwner === null ? "NULL" : sqlLiteral(leaseOwner)},
          ${leaseOwner === null ? "NULL" : "NOW() + INTERVAL '5 minutes'"},
          ${state === "claimed" ? "NOW()" : "NULL"}, NOW(), NOW()
        ) RETURNING delivery_id, state, aggregate_state, attempt_count, enqueue_sequence
      ) SELECT row_to_json(inserted) FROM inserted
    `);
  }

  async byId(deliveryId) {
    assertIdentifier(deliveryId, "delivery id");
    return await this.runtime.psqlOne(`
      SELECT row_to_json(delivery) FROM (
        SELECT delivery_id, state, aggregate_state, attempt_count,
          enqueue_sequence, target_receipt_id, caller_turn_id,
          dead_letter_reason, last_error
        FROM session_deliveries
        WHERE delivery_id = ${sqlLiteral(deliveryId)}
      ) AS delivery
    `);
  }

  async removeSeed(deliveryId) {
    assertIdentifier(deliveryId, "delivery id");
    return await this.runtime.psqlOne(`
      WITH removed AS (
        DELETE FROM session_deliveries
        WHERE delivery_id = ${sqlLiteral(deliveryId)}
          AND source = 'lab_fault_harness'
        RETURNING delivery_id
      ) SELECT json_build_object('removed', COUNT(*)::integer) FROM removed
    `);
  }

  async forSource(sourceSessionId) {
    assertIdentifier(sourceSessionId, "source session id");
    return await this.runtime.psqlOne(`
      SELECT row_to_json(delivery) FROM (
        SELECT delivery_id, relation_key, completion_id, source_session_id, target_session_id,
          state, aggregate_state, attempt_count, last_error,
          dead_letter_reason, consumed_reason
        FROM session_deliveries
        WHERE source_session_id = ${sqlLiteral(sourceSessionId)}
          AND intent = 'completion_notification'
        ORDER BY created_at DESC LIMIT 1
      ) AS delivery
    `);
  }

  async consumptionCount(relationKey) {
    assertIdentifier(relationKey, "relation key");
    const value = await this.runtime.psqlOne(`
      SELECT json_build_object('count', COUNT(*)::integer)
      FROM session_delivery_relation_consumptions
      WHERE relation_key = ${sqlLiteral(relationKey)}
    `);
    return value?.count ?? 0;
  }

  async installQueuedCasFault(deliveryId) {
    assertIdentifier(deliveryId, "delivery id");
    await this.runtime.psqlOne(`
      SELECT json_build_object('installed', TRUE) FROM (SELECT 1) AS marker;
      CREATE OR REPLACE FUNCTION lab_force_delivery_queued_cas()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.delivery_id = ${sqlLiteral(deliveryId)}
           AND OLD.state = 'claimed' AND NEW.state = 'dispatching' THEN
          UPDATE session_deliveries
          SET state = 'queued', aggregate_state = 'pending',
              queued_at = NOW(), updated_at = NOW()
          WHERE delivery_id = NEW.delivery_id AND state = 'dispatching';
        END IF;
        RETURN NULL;
      END;
      $$;
      DROP TRIGGER IF EXISTS lab_force_delivery_queued_cas_trigger
        ON session_deliveries;
      CREATE TRIGGER lab_force_delivery_queued_cas_trigger
      AFTER UPDATE OF state ON session_deliveries
      FOR EACH ROW EXECUTE FUNCTION lab_force_delivery_queued_cas()
    `);
  }

  async removeQueuedCasFault() {
    await this.runtime.psqlOne(`
      DROP TRIGGER IF EXISTS lab_force_delivery_queued_cas_trigger
        ON session_deliveries;
      DROP FUNCTION IF EXISTS lab_force_delivery_queued_cas();
      SELECT json_build_object('removed', TRUE)
    `);
  }
}

function assertIdentifier(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(`invalid ${field}`);
  }
}

function sqlLiteral(value) {
  assertIdentifier(value, "SQL identifier value");
  return `'${value}'`;
}

function sqlText(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 100_000) {
    throw new Error("invalid SQL text value");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

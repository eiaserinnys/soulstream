export async function installObservedAdoptionWindow(runtime, sessionId, delaySeconds = 20) {
  const sessionLiteral = sqlLiteral(sessionId, "session id");
  if (!Number.isInteger(delaySeconds) || delaySeconds < 5 || delaySeconds > 30) {
    throw new Error(`invalid adoption window delay: ${delaySeconds}`);
  }
  return await runtime.psqlOne(`
    DROP TRIGGER IF EXISTS lab_fault_observe_adoption_window
      ON session_execution_ownerships;
    CREATE OR REPLACE FUNCTION lab_fault_observe_adoption_window()
    RETURNS trigger LANGUAGE plpgsql AS $lab$
    BEGIN
      IF NEW.session_id = ${sessionLiteral}
         AND NEW.owner_kind = 'adopted_runner'
         AND OLD.phase = 'identity_proven'
         AND NEW.phase = 'active' THEN
        PERFORM pg_sleep(${delaySeconds});
      END IF;
      RETURN NEW;
    END;
    $lab$;
    CREATE TRIGGER lab_fault_observe_adoption_window
      BEFORE UPDATE OF phase ON session_execution_ownerships
      FOR EACH ROW EXECUTE FUNCTION lab_fault_observe_adoption_window();
    SELECT json_build_object(
      'installed', true,
      'sessionId', ${sessionLiteral},
      'delaySeconds', ${delaySeconds}
    );
  `);
}

export async function waitForObservedAdoptionWindow(runtime, sessionId, timeoutMs = 60_000) {
  const sessionLiteral = sqlLiteral(sessionId, "session id");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = await runtime.psqlOne(`
      SELECT json_build_object(
        'sessionId', ${sessionLiteral},
        'backendPid', pid,
        'state', state,
        'waitEvent', wait_event,
        'queryStartedAt', query_start
      )
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND wait_event = 'PgSleep'
        AND query LIKE '%session_activate_execution_ownership%'
      ORDER BY query_start DESC
      LIMIT 1
    `);
    if (observed) return observed;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`adoption recovery window was not observed for ${sessionId}`);
}

export async function removeObservedAdoptionWindow(runtime) {
  return await runtime.psqlOne(`
    DROP TRIGGER IF EXISTS lab_fault_observe_adoption_window
      ON session_execution_ownerships;
    DROP FUNCTION IF EXISTS lab_fault_observe_adoption_window();
    SELECT json_build_object('removed', true);
  `);
}

function sqlLiteral(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(`invalid ${field}`);
  }
  return `'${value}'`;
}

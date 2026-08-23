const RUNNER_TERMINAL_STATES = new Set(["completed", "failed", "reaped", "closed"]);
const RUNNER_PROGRESS_GRACE_MS = 60_000;
const OPEN_OWNERSHIP_PHASES = new Set(["reserved", "identity_proven", "active"]);

export const STRANDED_DELIVERY_CANDIDATES_SQL = `
  SELECT COALESCE(json_agg(json_build_object(
    'delivery_id', delivery.delivery_id,
    'target_session_id', delivery.target_session_id,
    'target_status', target.status,
    'owner_phase', owner.phase,
    'owner_pid', owner.pid
  )), '[]'::json)
  FROM session_deliveries AS delivery
  LEFT JOIN sessions AS target
    ON target.session_id = delivery.target_session_id
  LEFT JOIN LATERAL (
    SELECT ownership.phase, ownership.pid
    FROM session_execution_ownerships AS ownership
    WHERE ownership.session_id = delivery.target_session_id
      AND ownership.phase IN ('reserved', 'identity_proven', 'active')
    ORDER BY ownership.ownership_generation DESC
    LIMIT 1
  ) AS owner ON TRUE
  WHERE delivery.aggregate_state = 'delivered'
    AND delivery.delivered_at < NOW() - INTERVAL '120 seconds'
`;

/**
 * Delivered is not terminal: a live long-running turn may legitimately hold it.
 * Exemption requires recent real progress first, then a live owner PID as
 * corroboration. A PID alone is never progress, and an open row alone is never
 * ownership.
 */
export function findStrandedDeliveries(candidates, lifecycles, runtime) {
  return (candidates ?? [])
    .filter((candidate) => !deliveryOwnerIsAdvancing(candidate, lifecycles, runtime))
    .map(({ delivery_id, target_session_id }) => ({ delivery_id, target_session_id }));
}

export function runnerIsStillWorking(lifecycle, now = Date.now()) {
  if (!lifecycle || RUNNER_TERMINAL_STATES.has(lifecycle.execution_state)) return false;
  const progressedAt = Date.parse(lifecycle.progress_at ?? "") || 0;
  return now - progressedAt < RUNNER_PROGRESS_GRACE_MS;
}

function deliveryOwnerIsAdvancing(candidate, lifecycles, runtime) {
  if (candidate.target_status !== "running") return false;
  if (!OPEN_OWNERSHIP_PHASES.has(candidate.owner_phase)) return false;
  if (!runnerIsStillWorking(lifecycles.get(candidate.target_session_id))) return false;

  const pid = Number(candidate.owner_pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (typeof runtime.runnerAlive !== "function") return false;
  try { return runtime.runnerAlive(pid) === true; } catch { return false; }
}

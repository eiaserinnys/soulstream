\set ON_ERROR_STOP on

BEGIN;

INSERT INTO sessions (
    session_id,
    status,
    execution_generation,
    execution_manifest_id,
    execution_runtime_env_identity,
    execution_registration_id,
    execution_pid,
    execution_start_identity,
    execution_command_id,
    execution_lease_expires_at
) VALUES (
    'v1-red-causal-classifier-mutation',
    'completed',
    1,
    'manifest-mutation',
    'runtime-mutation',
    'registration-mutation',
    4242,
    'start-mutation',
    'execute-mutation',
    NOW() + INTERVAL '30 minutes'
);

SELECT 'MUTATION_OPEN_CANONICAL' AS observation,
       COUNT(*) AS terminal_open_owner_violations
  FROM sessions
 WHERE session_id = 'v1-red-causal-classifier-mutation'
   AND status IN ('completed', 'error', 'interrupted')
   AND execution_manifest_id IS NOT NULL
   AND execution_runtime_env_identity IS NOT NULL
   AND execution_registration_id IS NOT NULL
   AND execution_pid IS NOT NULL
   AND execution_start_identity IS NOT NULL
   AND execution_command_id IS NOT NULL
   AND execution_lease_expires_at IS NOT NULL;

UPDATE sessions
   SET execution_manifest_id = NULL,
       execution_runtime_env_identity = NULL,
       execution_registration_id = NULL,
       execution_pid = NULL,
       execution_start_identity = NULL,
       execution_command_id = NULL,
       execution_lease_expires_at = NULL
 WHERE session_id = 'v1-red-causal-classifier-mutation';

SELECT 'COUNTERFACTUAL_RELEASED' AS observation,
       COUNT(*) AS terminal_open_owner_violations
  FROM sessions
 WHERE session_id = 'v1-red-causal-classifier-mutation'
   AND status IN ('completed', 'error', 'interrupted')
   AND execution_manifest_id IS NOT NULL
   AND execution_runtime_env_identity IS NOT NULL
   AND execution_registration_id IS NOT NULL
   AND execution_pid IS NOT NULL
   AND execution_start_identity IS NOT NULL
   AND execution_command_id IS NOT NULL
   AND execution_lease_expires_at IS NOT NULL;

ROLLBACK;

SELECT 'ROLLBACK_RESIDUE' AS observation,
       COUNT(*) AS rows
  FROM sessions
 WHERE session_id = 'v1-red-causal-classifier-mutation';

-- A deployed policy is inert until an administrator explicitly enables it.
INSERT INTO system_settings(setting_key,value,updated_by)
VALUES('card_orchestration','{"enabled":false,"candidates":[],"usageMaxAgeMs":300000,"sessionFolderId":null,"systemFolderParentId":null}'::jsonb,'migration')
ON CONFLICT(setting_key) DO NOTHING;
CREATE TABLE card_orchestration_state (
 id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id),
 last_decision_input_hash TEXT,
 state TEXT NOT NULL DEFAULT 'off', reason TEXT,
 provision_id TEXT, provision_request JSONB, resolved_folder_id TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO card_orchestration_state(id) VALUES(TRUE);
CREATE TABLE card_orchestration_runs (
 id TEXT PRIMARY KEY, policy_version INTEGER NOT NULL,
 input_hash TEXT NOT NULL, snapshot JSONB NOT NULL, input_context JSONB NOT NULL DEFAULT '{}',
 target JSONB NOT NULL, session_id TEXT NOT NULL UNIQUE,
 execution_token TEXT NOT NULL, execution_claimed BOOLEAN NOT NULL DEFAULT FALSE,
 lease_token TEXT NOT NULL, lease_expires_at TIMESTAMPTZ NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('reserved','judging','decided','completed','blocked','cancelled')),
 attempt INTEGER NOT NULL DEFAULT 1, retry_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 decision JSONB, decision_event_id BIGINT, instructions_revision TEXT, reason TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX card_orchestration_one_active ON card_orchestration_runs((TRUE)) WHERE state IN ('reserved','judging','decided');
CREATE TABLE card_orchestration_dispatches (
 run_id TEXT NOT NULL REFERENCES card_orchestration_runs(id),card_id TEXT NOT NULL,
 session_id TEXT NOT NULL,node_id TEXT NOT NULL, input JSONB NOT NULL,
 launch_token TEXT NOT NULL,launch_accepted BOOLEAN NOT NULL DEFAULT FALSE,launch_deadline TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '2 minutes',
 state TEXT NOT NULL CHECK(state IN ('admitted','launching','running','rejected')),
 reason TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(run_id,card_id)
);
CREATE UNIQUE INDEX card_orchestration_one_pending_worker ON card_orchestration_dispatches(session_id) WHERE state IN ('admitted','launching');

import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";

export const OWNERLESS_NODE_ID = "node-ownerless-red";

export const LIVE_OWNER_IDENTITY = {
  ownerKind: "adopted_runner" as const,
  manifestId: "manifest-ownerless-red",
  runtimeEnvIdentity: "runtime-ownerless-red",
  registrationId: "registration-ownerless-red",
  pid: 4312,
  startIdentity: "start-ownerless-red",
  executionCommandId: "execute-ownerless-red",
} as const;

export interface OwnerlessSessionSnapshot {
  status: string;
  terminationReason: string | null;
  terminationDetail: string | null;
  terminationEventId: number | null;
  generation: number;
  manifestId: string | null;
  runtimeEnvIdentity: string | null;
  registrationId: string | null;
  pid: number | null;
  startIdentity: string | null;
  executionCommandId: string | null;
  terminalEventCount: number;
  runningCatalogVisible: boolean;
}

export function makeOwnerlessRegistration(
  sessionId: string,
  nowMs: number,
  overrides: {
    registrationId?: string;
    progressedAtMs?: number;
    pidAlive?: boolean;
  } = {},
): RunnerRegistration {
  const registrationId = overrides.registrationId ?? LIVE_OWNER_IDENTITY.registrationId;
  const progressedAt = new Date(overrides.progressedAtMs ?? nowMs - 500).toISOString();
  return {
    config: {
      schemaVersion: 1,
      sessionId,
      backend: "codex",
      agent: {
        id: "agent-ownerless-red",
        name: "Ownerless RED",
        backend: "codex",
        workspace_dir: "/workspace/ownerless-red",
      },
      paths: {
        sessionDirectory: `/runner/${sessionId}`,
        databasePath: `/runner/${sessionId}/runner.sqlite`,
        socketPath: `/runner/${sessionId}/runner.sock`,
        pidPath: `/runner/${sessionId}/runner.pid`,
        lockPath: `/runner/${sessionId}/runner.lock`,
        configPath: `/runner/${sessionId}/runner-config.json`,
      },
      codeSha: LIVE_OWNER_IDENTITY.manifestId,
      releaseManifestId: LIVE_OWNER_IDENTITY.manifestId,
      runtimeEnvIdentity: LIVE_OWNER_IDENTITY.runtimeEnvIdentity,
      snapshotPath: "/release/ownerless-red/soul-server-ts",
      codexAdapterMode: "sdk",
      claudeRuntimeV2Enabled: true,
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 16,
      claudeRuntimeTurnTimeoutMs: 600_000,
      internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
      codexHome: "/home/test/.codex",
      rolloutRoot: "/home/test/.codex/sessions",
    },
    pid: LIVE_OWNER_IDENTITY.pid,
    registrationId,
    pidStartIdentity: LIVE_OWNER_IDENTITY.startIdentity,
    pidAlive: overrides.pidAlive ?? true,
    registeredAtMs: nowMs - 1_000,
    bootstrap: {
      stream_id: `stream-${sessionId}`,
      source_seq: 1,
      session_id: sessionId,
      event_type: "runner_bootstrap",
      payload: {
        schema_version: 1,
        backend_session_id: `thread-${sessionId}`,
        cwd: "/workspace/ownerless-red",
        codex_home: "/home/test/.codex",
        rollout_root: "/home/test/.codex/sessions",
        code_sha: LIVE_OWNER_IDENTITY.manifestId,
        snapshot_path: "/release/ownerless-red/soul-server-ts",
      },
      searchable_text: null,
      created_at: new Date(nowMs - 1_000).toISOString(),
      semantic_dedupe_key: null,
      session_effect: null,
      payload_hash: "0".repeat(64),
    },
    lifecycle: {
      session_id: sessionId,
      runner_pid: LIVE_OWNER_IDENTITY.pid,
      execution_command_id: LIVE_OWNER_IDENTITY.executionCommandId,
      execution_state: "running",
      progress_seq: 3,
      progress_at: progressedAt,
      liveness_at: progressedAt,
      in_flight_tools: [],
      terminal_error: null,
    },
  };
}

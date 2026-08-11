import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildServiceEnvironments,
  resolveSoakConfig,
  type SoakConfigFile,
} from "../../scripts/staging-soak/config.js";
import {
  exportRunnerEvidence,
  fixtureCandidateFromEnvelope,
  parseSseChunk,
} from "../../scripts/staging-soak/event_evidence.js";
import { stagingDatabaseUrl } from "../../scripts/staging-soak/database.js";

const REPOSITORY_ROOT = "/srv/soulstream";
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

function validConfig(overrides: Partial<SoakConfigFile> = {}): SoakConfigFile {
  return {
    schemaVersion: 1,
    stagingRoot: ".local/runner-staging-soak",
    host: "127.0.0.1",
    orchPort: 15_200,
    soulPort: 13_105,
    databaseName: "soulstream_runner_soak",
    databaseAdminUrlEnv: "SOUL_RUNNER_SOAK_DATABASE_ADMIN_URL",
    authBearerTokenEnv: "SOUL_RUNNER_SOAK_AUTH_BEARER_TOKEN",
    claudeAuthTokenPathEnv: "SOUL_RUNNER_SOAK_CLAUDE_AUTH_TOKEN_PATH",
    codexHomePathEnv: "SOUL_RUNNER_SOAK_CODEX_HOME_PATH",
    claudeOauthClientId: "staging-soak-unused",
    profile: "runner-soak-claude",
    modelPreset: "claude-sonnet",
    codexProfile: "runner-soak-codex",
    codexModelPreset: "codex-5.6-sol",
    durationMinutes: 35,
    restartAfterMinutes: 10,
    interventionEveryMinutes: 5,
    maxSessions: 1,
    leaseTimeoutMs: 120_000,
    reaperIntervalMs: 5_000,
    turnTimeoutMs: 1_800_000,
    ...overrides,
  };
}

describe("runner staging soak isolation contract", () => {
  it.each([3_105, 5_200, 4_205])("rejects live port %s", (port) => {
    expect(() => resolveSoakConfig(
      validConfig({ orchPort: port }),
      REPOSITORY_ROOT,
    )).toThrow(/live port/i);
  });

  it("rejects non-staging database names and roots outside the owned boundary", () => {
    expect(() => resolveSoakConfig(
      validConfig({ databaseName: "soulstream" }),
      REPOSITORY_ROOT,
    )).toThrow(/database name/i);
    expect(() => resolveSoakConfig(
      validConfig({ stagingRoot: ".local/other-system" }),
      REPOSITORY_ROOT,
    )).toThrow(/staging root/i);
  });

  it("derives all-on service environments without leaking live paths", () => {
    const config = resolveSoakConfig(validConfig(), REPOSITORY_ROOT);
    const environments = buildServiceEnvironments(config, {
      databaseUrl: "postgresql://staging.example/soulstream_runner_soak",
      authBearerToken: "staging-secret",
      claudeAuthTokenPath: "/secure/staging-claude-oauth.json",
      codexHomePath: "/secure/staging-codex-home",
    });

    expect(environments.orch).toMatchObject({
      HOST: "127.0.0.1",
      PORT: "15200",
      DATABASE_URL: "postgresql://staging.example/soulstream_runner_soak",
      SOUL_RUNNER_PROCESS_ENABLED: "true",
    });
    expect(environments.soul).toMatchObject({
      HOST: "127.0.0.1",
      PORT: "13105",
      SOULSTREAM_UPSTREAM_URL: "ws://127.0.0.1:15200/ws/node",
      SOUL_RUNNER_PROCESS_ENABLED: "true",
      MCP_ENABLED: "true",
      MCP_STATELESS_TRANSPORT_ENABLED: "true",
      CLAUDE_AUTH_TOKEN_PATH: "/secure/staging-claude-oauth.json",
      CODEX_HOME: "/secure/staging-codex-home",
      CODEX_ADAPTER_MODE: "app-server",
    });
    expect(environments.soul.SOUL_RUNNER_STATE_DIR).toMatch(
      /^\/tmp\/soul-runner-soak-[a-f0-9]{12}$/,
    );
    expect(config.paths.runnerStateStorage).toBe(
      "/srv/soulstream/.local/runner-staging-soak/runtime/runner-state",
    );
    expect(`${config.paths.runnerState}/${"a".repeat(24)}/runner.sock`.length).toBeLessThan(108);
    expect(environments.orch.PORT).not.toBe("5200");
    expect(environments.soul.PORT).not.toBe("3105");
    expect(environments.soul.PORT).not.toBe("4205");
  });

  it("derives only a dedicated target from a maintenance database URL", () => {
    expect(stagingDatabaseUrl(
      "postgresql://user:secret@127.0.0.1:5432/postgres",
      "soulstream_runner_soak",
    )).toBe("postgresql://user:secret@127.0.0.1:5432/soulstream_runner_soak");
    expect(() => stagingDatabaseUrl(
      "postgresql://user:secret@127.0.0.1:5432/soulstream",
      "soulstream_runner_soak",
    )).toThrow(/postgres or template1/);
  });
});

describe("runner staging soak evidence", () => {
  it("parses complete SSE frames while preserving a partial tail", () => {
    const parsed = parseSseChunk(
      "",
      "event: session_event\nid: 7\ndata: {\"event\":{\"type\":\"rate_limit\"}}\n\n"
        + "event: session_event\ndata: {\"event\":",
    );
    expect(parsed.frames).toEqual([{
      event: "session_event",
      id: "7",
      data: { event: { type: "rate_limit" } },
    }]);
    expect(parsed.tail).toContain("event: session_event");
  });

  it("exports fixture candidates with secret and volatile values redacted", () => {
    expect(fixtureCandidateFromEnvelope({
      event: "session_event",
      id: "99",
      data: {
        agentSessionId: "d4ff1f5d-116d-4b05-9934-a841dab1058a",
        event: {
          type: "tool_start",
          toolName: "Bash",
          toolInput: { command: "printf soak", authorization: "Bearer secret" },
          createdAt: "2026-08-11T00:00:00.000Z",
        },
      },
    })).toEqual({
      source: "orch_sse",
      event: "session_event",
      data: {
        agentSessionId: "<session-id>",
        event: {
          type: "tool_start",
          toolName: "Bash",
          toolInput: { command: "printf soak", authorization: "<redacted>" },
          createdAt: "<timestamp>",
        },
      },
    });
  });

  it("exports the runner event ledger and payload-free IPC journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-soak-evidence-"));
    const sessionId = "session-soak-1";
    const slug = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
    const sessionDirectory = join(root, "runtime", "runner-state", slug);
    await mkdir(sessionDirectory, { recursive: true });
    const databasePath = join(sessionDirectory, "runner.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE runner_event_outbox (
        source_seq INTEGER PRIMARY KEY,
        record_kind TEXT,
        stream_id TEXT,
        session_id TEXT,
        event_type TEXT,
        payload_json TEXT,
        session_effect_json TEXT,
        runner_metadata_json TEXT,
        payload_hash TEXT,
        created_at TEXT,
        acked_through INTEGER
      );
      CREATE TABLE runner_ipc_journal (
        frame_seq INTEGER PRIMARY KEY,
        outbox_source_seq INTEGER,
        correlation_id TEXT,
        frame_kind TEXT,
        host_acked INTEGER,
        service TEXT,
        operation TEXT,
        created_at TEXT
      );
      INSERT INTO runner_event_outbox VALUES (
        2, 'event', 'stream-1', '${sessionId}', 'rate_limit',
        '{"type":"rate_limit","status":"allowed"}', NULL, NULL,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '2026-08-11T00:00:00.000Z', 2
      );
      INSERT INTO runner_ipc_journal VALUES (
        1, 2, NULL, 'engine_event', 1, NULL, NULL,
        '2026-08-11T00:00:00.000Z'
      );
    `);
    database.close();

    const outputDirectory = join(root, "captures", "run-1");
    const manifest = await exportRunnerEvidence({
      sessionId,
      runnerStateDirectory: join(root, "runtime", "runner-state"),
      outputDirectory,
    });

    expect(manifest.eventCount).toBe(1);
    expect(manifest.journalCount).toBe(1);
    const events = await readFile(join(outputDirectory, "runner-events.jsonl"), "utf8");
    const eventRecord = JSON.parse(events.trim()) as Record<string, unknown>;
    expect(eventRecord.event_type).toBe("rate_limit");
    expect(JSON.parse(String(eventRecord.payload_json))).toEqual({
      type: "rate_limit",
      status: "allowed",
    });
    const journal = await readFile(join(outputDirectory, "runner-ipc-journal.jsonl"), "utf8");
    expect(journal).not.toContain("payload_json");
    await writeFile(join(root, "done"), "ok\n");
  });
});

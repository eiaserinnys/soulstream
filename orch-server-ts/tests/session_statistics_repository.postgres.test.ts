import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import type { BoardYjsSql } from "../src/board-yjs/board_yjs_sql.js";
import type { EventIngressQuerySql } from "../src/node/event_ingress_repository.js";
import {
  SESSION_STATISTICS_PROJECTION_SETTING_KEY,
} from "../src/usage/session_statistics_backfill.js";
import { insertSessionStatisticsFacts } from "../src/usage/session_statistics_projection.js";
import {
  normalizeSessionStatisticsEvent,
  type SessionStatisticsEventInput,
} from "../src/usage/session_statistics_normalizer.js";
import { SessionStatisticsRepository } from "../src/usage/session_statistics_repository.js";
import type { SessionStatisticsReadRequest } from "../src/usage/session_statistics_types.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./board_yjs_postgres_harness.js";

const hasDocker = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL?.trim());
const describePostgres = hasDocker || hasTestDatabase ? describe : describe.skip;

describePostgres("session statistics repository", () => {
  let harness: FullSchemaPostgresHarness;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    sql = harness.sql;
  }, 60_000);

  it("reads the earliest authorized session creation without requiring an event", async () => {
    await sql`INSERT INTO folders (id, name) VALUES ('earliest-visible', 'Visible'), ('earliest-hidden', 'Hidden')`;
    await sql`
      INSERT INTO sessions (session_id, folder_id, status, session_type, created_at) VALUES
        ('earliest-visible-session', 'earliest-visible', 'idle', 'claude', '2026-09-15T00:00:00Z'),
        ('earliest-hidden-session', 'earliest-hidden', 'idle', 'claude', '2026-09-05T00:00:00Z'),
        ('earliest-at-cutoff', 'earliest-visible', 'idle', 'claude', '2026-10-20T00:00:00Z')
    `;
    await sql`
      UPDATE system_settings SET value = ${sql.json({
        state: "ready", normalization_version: 1, covered_since: "2026-09-01T00:00:00Z",
      })}, version = version + 1
      WHERE setting_key = ${SESSION_STATISTICS_PROJECTION_SETTING_KEY}
    `;
    const repository = new SessionStatisticsRepository(sql as unknown as BoardYjsSql);
    const request: SessionStatisticsReadRequest = {
      query: { period: "all", anchor: "2026-10-20" }, timezone: "Asia/Seoul", asOf: "2026-10-20T00:00:00Z",
      access: { restricted: true, allowedFolderIds: ["earliest-visible"] },
      visibleFolders: [{ id: "earliest-visible", name: "Visible", parentFolderId: null }], day: null,
    };
    const result = await repository.read(request);
    expect(result.range.since).toBe("2026-09-15");
    expect(result.projectionStatus.covered_since).toBe("2026-09-15");
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("authorizes sessions, caps canonical siblings at asOf, and scopes material by read purpose", async () => {
    await sql`
      INSERT INTO folders (id, name, parent_folder_id) VALUES
        ('allowed-root', 'Allowed project', NULL),
        ('allowed-child', 'Child folder', 'allowed-root'),
        ('hidden-root', 'Hidden project', NULL),
        ('hidden-child', 'Hidden child', 'hidden-root')
    `;
    await sql`
      INSERT INTO cards (id, folder_id, position_key, title)
      VALUES ('allowed-card', 'allowed-root', 'a', 'Card in allowed project')
    `;
    await sql`
      INSERT INTO sessions (session_id, folder_id, card_id, status, session_type, created_at) VALUES
        ('statistics-authorized', 'allowed-child', NULL, 'idle', 'claude', '2026-10-01T00:00:00Z'),
        ('statistics-hidden-card', 'hidden-child', 'allowed-card', 'idle', 'claude', '2019-01-01T00:00:00Z'),
        ('statistics-restricted-card-fallback', NULL, 'allowed-card', 'idle', 'claude', '2020-01-01T00:00:00Z')
    `;

    const events = createEvents();
    await insertSourceEvents(sql, events);
    const facts = events.flatMap((event) => normalizeSessionStatisticsEvent(event).facts)
      .map((fact) => fact.session_id === "statistics-authorized"
        && String(fact.event_id) === "4"
        && fact.fact_kind === "usage"
        ? { ...fact, known_cost_usd: 0.1 }
        : fact);
    await insertSessionStatisticsFacts(sql as unknown as EventIngressQuerySql, facts);

    const costFact = facts.find((fact) => fact.session_id === "statistics-authorized"
      && String(fact.event_id) === "4"
      && fact.fact_kind === "usage");
    expect(costFact).toBeDefined();
    await sql`
      UPDATE session_statistics_facts
      SET known_cost_usd = '0.1000000000000000001'::numeric
      WHERE session_id = 'statistics-authorized'
        AND event_id = 4
        AND part_key = ${costFact!.part_key}
    `;
    await sql`
      UPDATE system_settings
      SET value = ${sql.json({
        state: "ready",
        normalization_version: 1,
        covered_since: "2026-09-01T00:00:00.000Z",
        backfill_cutoff_event_id: 12,
        last_session_id: "statistics-authorized",
        last_event_id: 12,
      })}, version = version + 1
      WHERE setting_key = ${SESSION_STATISTICS_PROJECTION_SETTING_KEY}
    `;

    const allowedFolders = [
      { id: "allowed-root", name: "Allowed project", parentFolderId: null },
      { id: "allowed-child", name: "Child folder", parentFolderId: "allowed-root" },
    ];
    const repository = new SessionStatisticsRepository(sql as unknown as BoardYjsSql);
    const request: SessionStatisticsReadRequest = {
      query: { period: "week", anchor: "2026-10-19" },
      timezone: "Asia/Seoul",
      asOf: "2026-10-26T04:00:00.000Z",
      access: { restricted: true, allowedFolderIds: ["allowed-root"] },
      visibleFolders: allowedFolders,
      day: null,
    };

    const overview = await repository.read(request);
    expect(overview.sessions.map((session) => session.sessionId)).toEqual(["statistics-authorized"]);
    expect(overview.sessions[0]).toMatchObject({
      folderId: "allowed-child",
      projectId: "allowed-root",
      projectLabel: "Allowed project",
    });
    expect(overview.collectionCoverage).toBe("unknown");
    expect(overview.projectionStatus).toEqual({ state: "ready", covered_since: "2026-10-01" });
    expect(overview.rows.some((row) => row.row_kind === "input_material" || row.row_kind === "tool_call")).toBe(false);

    const periodOwner = overview.rows.find((row) => row.row_kind === "usage"
      && row.accounting_key === "period-command"
      && row.state === "owned");
    expect(periodOwner).toMatchObject({
      owner_event_id: 4,
      owner_recorded_at: "2026-10-25T18:00:00.000Z",
    });
    expect(overview.rows.some((row) => row.fact?.event_id === 5)).toBe(false);
    expect(overview.rows.some((row) => row.fact?.event_id === 1)).toBe(false);
    const lateTerminal = overview.rows.find((row) => row.row_kind === "usage" && row.owner_event_id === 15);
    expect(lateTerminal).toMatchObject({
        input_id: "late-terminal-input",
        candidate_type: "complete",
        state: "owned",
        fact: { input_total: 20, output_total: 5 },
      });
    expect(String(lateTerminal?.fact?.event_id)).toBe("15");
    expect(overview.rows.some((row) => row.fact?.event_id === 16)).toBe(false);
    expect(overview.costDecimals.get(JSON.stringify([
      "statistics-authorized", "4", costFact!.part_key,
    ]))).toBe("0.1000000000000000001");

    const day = await repository.read({ ...request, day: "2026-10-19" });
    const selectedMaterials = day.rows.filter((row) => row.row_kind === "input_material");
    expect(selectedMaterials.map((row) => row.fact?.event_id)).toEqual([10]);
    expect(day.rows.some((row) => row.row_kind === "tool_call" && row.fact?.event_id === 7)).toBe(true);
    expect(day.rows.some((row) => row.fact?.event_id === 1 || row.fact?.event_id === 5)).toBe(false);

    const unrestricted = await repository.read({
      ...request,
      access: { restricted: false, allowedFolderIds: [] },
      visibleFolders: [
        ...allowedFolders,
        { id: "hidden-root", name: "Hidden project", parentFolderId: null },
        { id: "hidden-child", name: "Hidden child", parentFolderId: "hidden-root" },
      ],
    });
    expect(unrestricted.sessions.find((session) => session.sessionId === "statistics-hidden-card")?.projectId)
      .toBe("hidden-root");
    expect(unrestricted.sessions.find((session) => session.sessionId === "statistics-restricted-card-fallback"))
      .toMatchObject({ folderId: null, cardFolderId: "allowed-root", projectId: "allowed-root" });

    await sql`
      UPDATE system_settings
      SET value = ${sql.json({ state: "ready", normalization_version: 1, covered_since: null })}
      WHERE setting_key = ${SESSION_STATISTICS_PROJECTION_SETTING_KEY}
    `;
    await expect(repository.read(request)).rejects.toThrow("not initialized");
    await sql`
      UPDATE system_settings
      SET value = ${sql.json({
        state: "ready", normalization_version: 2, covered_since: "2026-09-01T00:00:00.000Z",
      })}
      WHERE setting_key = ${SESSION_STATISTICS_PROJECTION_SETTING_KEY}
    `;
    await expect(repository.read(request)).rejects.toThrow("normalization version is unsupported");
  }, 60_000);
});

async function insertSourceEvents(
  sql: ReturnType<typeof postgres>,
  events: readonly SessionStatisticsEventInput[],
): Promise<void> {
  for (const event of events) {
    await sql`
      INSERT INTO events (session_id, id, event_type, payload, created_at)
      VALUES (
        ${event.sessionId}, ${Number(event.eventId)}, ${event.eventType},
        ${sql.json(event.payload as Parameters<typeof sql.json>[0])}::jsonb,
        ${event.createdAt}
      )
    `;
  }
}

function createEvents(): SessionStatisticsEventInput[] {
  const sessionId = "statistics-authorized";
  return [
    event("statistics-hidden-card", 1, "user_message", "2019-01-01T00:00:00.000Z", {
      type: "user_message", input_id: "hidden-earliest", text: "hidden history",
    }),
    event("statistics-restricted-card-fallback", 1, "user_message", "2020-01-01T00:00:00.000Z", {
      type: "user_message", input_id: "unfolder-earliest", text: "unfolder history",
    }),
    event(sessionId, 1, "user_message", "2026-10-01T00:00:00.000Z", {
      type: "user_message", input_id: "historic-input", text: "historic material",
    }),
    event(sessionId, 2, "user_message", "2026-10-25T13:00:00.000Z", {
      type: "user_message", input_id: "period-input", text: "period prompt",
    }),
    event(sessionId, 3, "result", "2026-10-25T14:00:00.000Z", {
      type: "result", success: false, output_command_id: "period-command", input_id: "period-input",
      model: "gpt-6-luna", usage: { input_tokens: 80, output_tokens: 10 },
      usage_snapshot: usageSnapshot(),
    }),
    event(sessionId, 4, "complete", "2026-10-25T18:00:00.000Z", {
      type: "complete", output_command_id: "period-command", input_id: "period-input",
      model: "gpt-6-luna", usage: { input_tokens: 12, output_tokens: 3 },
      usage_snapshot: usageSnapshot(),
    }),
    event(sessionId, 5, "complete", "2026-10-26T05:00:00.000Z", {
      type: "complete", output_command_id: "period-command", input_id: "period-input",
      model: "gpt-6-luna", usage: { input_tokens: 900, output_tokens: 90 },
      usage_snapshot: usageSnapshot(),
    }),
    event(sessionId, 6, "user_message", "2026-10-19T13:00:00.000Z", {
      type: "user_message", input_id: "day-input", text: "selected day prompt",
    }),
    event(sessionId, 7, "tool_start", "2026-10-19T14:00:00.000Z", {
      type: "tool_start", output_command_id: "day-command", input_id: "day-input", tool_use_id: "tool-1",
    }),
    event(sessionId, 8, "complete", "2026-10-19T14:30:00.000Z", {
      type: "complete", output_command_id: "day-command", input_id: "day-input",
      model: "gpt-6-luna", usage: { input_tokens: 7, output_tokens: 3 },
      usage_snapshot: usageSnapshot(),
    }),
    event(sessionId, 9, "input_material_manifest", "2026-10-19T14:45:00.000Z", manifest("day-command", "day-input", 100)),
    event(sessionId, 10, "input_material_manifest", "2026-10-19T15:30:00.000Z", manifest("day-command", "day-input", 999)),
    event(sessionId, 11, "input_material_manifest", "2026-10-19T15:45:00.000Z", manifest("unrelated-command", "day-input", 777)),
    event(sessionId, 12, "complete", "2026-10-26T05:00:00.000Z", {
      type: "complete", output_command_id: "period-command", input_id: "period-input",
      model: "gpt-6-luna", usage: { input_tokens: 999, output_tokens: 999 },
      usage_snapshot: usageSnapshot(),
    }),
    event(sessionId, 13, "user_message", "2026-10-25T13:30:00.000Z", {
      type: "user_message", input_id: "late-terminal-input", text: "late completion prompt",
    }),
    event(sessionId, 14, "user_message", "2026-10-25T17:00:00.000Z", {
      type: "user_message", input_id: "after-late-input", text: "following prompt",
    }),
    event(sessionId, 15, "complete", "2026-10-25T18:00:00.000Z", {
      type: "complete", input_id: "late-terminal-input",
      model: "gpt-6-luna", usage: { input_tokens: 20, output_tokens: 5 },
      usage_snapshot: usageSnapshot(),
    }),
    event(sessionId, 16, "complete", "2026-10-26T05:30:00.000Z", {
      type: "complete", input_id: "late-terminal-input",
      model: "gpt-6-luna", usage: { input_tokens: 900, output_tokens: 90 },
      usage_snapshot: usageSnapshot(),
    }),
  ];
}

function event(
  sessionId: string,
  eventId: number,
  eventType: string,
  createdAt: string,
  payload: Record<string, unknown>,
): SessionStatisticsEventInput {
  return { sessionId, eventId, eventType, createdAt, payload };
}

function manifest(commandId: string, inputId: string, approximateTokens: number): Record<string, unknown> {
  return {
    type: "input_material_manifest",
    output_command_id: commandId,
    input_id: inputId,
    execution_input: {
      command_id: commandId,
      parts: [{
        category: "system_prompt",
        source_key: "system/prompt",
        raw_chars_utf16: 1000,
        approximate_tokens: approximateTokens,
        estimate_source: "manifest",
      }],
    },
  };
}

function usageSnapshot() {
  return {
    schema_version: 1,
    backend: "codex",
    provider: "codex",
    preset_id: null,
    requested_model: "gpt-6-luna",
    provider_attribution: "configured_alias",
  };
}

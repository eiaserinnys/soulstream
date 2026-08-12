import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

const PERSISTENT_PUBLISHER_SURFACES = {
  engine: ["task/task_engine_event_publisher.ts"],
  initial: [
    "task/task_initial_message_publisher.ts",
    "task/task_user_message_events.ts",
  ],
  intervention: ["task/task_intervention_events.ts"],
  response: ["task/task_response_event_publisher.ts"],
  sessionNotification: ["task/task_session_notification.ts"],
  terminalLifecycle: ["task/task_lifecycle_transition.ts"],
  llmProxy: ["llm/executor.ts"],
  realtime: ["realtime/realtime_broker.ts"],
  schedule: ["schedule/schedule_service.ts"],
} as const;

const DIRECT_EVENT_APPEND_INVENTORY = {};

const WIRE_EVENT_ENVELOPE_INVENTORY = {
  "task/task_engine_event_publisher.ts": 1,
  "task/task_engine_failure_recovery.ts": 1,
  "upstream/session_broadcaster.ts": 3,
};

const FORBIDDEN_SESSION_MUTATION_PROCEDURES = [
  "session_register_with_model_preset",
  "session_acknowledge_review",
  "session_set_claude_id",
  "session_update_last_message",
  "session_append_metadata",
  "session_apply_metadata_entry",
  "session_rename",
  "session_delete",
  "session_update",
] as const;

describe("persistent publisher inventory", () => {
  it("keeps all nine publisher surfaces on the durable outbox ingress", () => {
    expect(Object.keys(PERSISTENT_PUBLISHER_SURFACES)).toHaveLength(9);

    for (const paths of Object.values(PERSISTENT_PUBLISHER_SURFACES)) {
      for (const path of paths) {
        const source = readSource(path);
        expect(source, path).toMatch(
          /\.enqueue(?:Event(?:AndWaitForSessionAck)?|TerminalTransitionAndWaitForApplication)\(/,
        );
        expect(source, path).not.toMatch(/\.appendEvent\(/);
        if (path !== "task/task_engine_event_publisher.ts") {
          expect(source, path).not.toMatch(/\.emitEventEnvelope\(/);
        }
      }
    }
  });

  it("fails when a worker source adds a direct DB event append bypass", () => {
    expect(countCallSites("appendEvent")).toEqual(DIRECT_EVENT_APPEND_INVENTORY);
  });

  it("keeps direct event envelopes limited to classified transient publishers", () => {
    expect(countCallSites("emitEventEnvelope")).toEqual(WIRE_EVENT_ENVELOPE_INVENTORY);
  });

  it("keeps every session mutation stored procedure out of worker source", () => {
    for (const procedure of FORBIDDEN_SESSION_MUTATION_PROCEDURES) {
      expect(countProcedureCalls(procedure), procedure).toEqual({});
    }
  });
});

function readSource(path: string): string {
  return readFileSync(join(SRC_ROOT, path), "utf8");
}

function countProcedureCalls(procedure: string): Record<string, number> {
  const result: Record<string, number> = {};
  const pattern = new RegExp(`\\b${procedure}\\s*\\(`, "g");
  for (const path of listTypeScriptFiles(SRC_ROOT)) {
    const source = readFileSync(path, "utf8");
    const count = source.match(pattern)?.length ?? 0;
    if (count > 0) result[relative(SRC_ROOT, path)] = count;
  }
  return result;
}

function countCallSites(symbol: string): Record<string, number> {
  const result: Record<string, number> = {};
  const pattern = new RegExp(`\\b${symbol}\\(`, "g");
  for (const path of listTypeScriptFiles(SRC_ROOT)) {
    const source = readFileSync(path, "utf8");
    const count = source.match(pattern)?.length ?? 0;
    if (count > 0) result[relative(SRC_ROOT, path)] = count;
  }
  return result;
}

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

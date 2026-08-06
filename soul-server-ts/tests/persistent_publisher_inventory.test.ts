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

const DIRECT_EVENT_APPEND_INVENTORY = {
  "custom_view/custom_view_service.ts": 3,
  "db/repositories/event_repository.ts": 1,
  "db/session_db.ts": 2,
};

const WIRE_EVENT_ENVELOPE_INVENTORY = {
  "task/task_engine_event_publisher.ts": 1,
  "task/task_engine_failure_recovery.ts": 1,
  "upstream/session_broadcaster.ts": 3,
};

describe("persistent publisher inventory", () => {
  it("keeps all nine publisher surfaces on the durable outbox ingress", () => {
    expect(Object.keys(PERSISTENT_PUBLISHER_SURFACES)).toHaveLength(9);

    for (const paths of Object.values(PERSISTENT_PUBLISHER_SURFACES)) {
      for (const path of paths) {
        const source = readSource(path);
        expect(source, path).toMatch(/\.enqueueEvent(?:AndWaitForSessionAck)?\(/);
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
});

function readSource(path: string): string {
  return readFileSync(join(SRC_ROOT, path), "utf8");
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

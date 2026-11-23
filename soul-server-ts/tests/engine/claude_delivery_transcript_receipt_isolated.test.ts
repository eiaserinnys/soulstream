import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDeliveryInputUuid } from "@soulstream/wire-schema/delivery";
import type { SessionDeliveryRow } from "@soulstream/wire-schema/session-delivery";
import type { SessionRow } from "../../src/db/session_db_types.js";
import { ClaudeDeliveryTranscriptReceiptReader } from "../../src/engine/claude_delivery_transcript_receipt.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("isolated Claude transcript receipt", () => {
  it.each(["completed", "input_pending", "absent"] as const)("returns %s from the sandbox when the server transcript is absent", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "receipt-"));
    roots.push(root);
    const inputUuid = buildDeliveryInputUuid("delivery-1");
    const projects = join(runnerProcessPaths(root, "target").sessionDirectory, "sandbox", "claude-config", "projects", "project");
    if (kind !== "absent") {
      await mkdir(projects, { recursive: true });
      const entries = [{ type: "user", uuid: inputUuid, message: { role: "user", content: "hello" } }];
      if (kind === "completed") entries.push({ type: "assistant", uuid: "answer", message: { role: "assistant", content: "done" } });
      await writeFile(join(projects, "claude-session.jsonl"), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    }
    const reader = new ClaudeDeliveryTranscriptReceiptReader({
      sourceNode: "node-a", runnerStateDirectory: root,
      getSession: async () => ({ session_id: "target", node_id: "node-a", agent_id: "agent", claude_session_id: "claude-session" } as SessionRow),
      getAgent: () => ({ id: "agent", name: "Claude", backend: "claude", workspace_dir: "/workspace" }),
      loadMessages: vi.fn().mockResolvedValue([]),
    });
    const receipt = await reader.inspect({ delivery_id: "delivery-1", target_session_id: "target" } as SessionDeliveryRow);
    expect(receipt).toEqual(kind === "completed"
      ? { kind, inputUuid, assistantMessageUuid: "answer" }
      : { kind, inputUuid });
  });
});

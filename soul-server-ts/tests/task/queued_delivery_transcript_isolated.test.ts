import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { buildDeliveryInputUuid } from "@soulstream/wire-schema/delivery";
import type { SessionDeliveryRow } from "@soulstream/wire-schema/session-delivery";
import type { SessionRow } from "../../src/db/session_db_types.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import { composeQueuedDeliveryRecovery } from "../../src/runtime/claude_runtime_composition.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>(),
  getSessionMessages: vi.fn().mockResolvedValue([]),
}));

it("settles an isolated transcript receipt without redelivering after node restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "recovery-"));
  try {
    const projects = join(runnerProcessPaths(root, "target").sessionDirectory, "sandbox", "claude-config", "projects", "project");
    await mkdir(projects, { recursive: true });
    await writeFile(join(projects, "claude-session.jsonl"), [
      { type: "user", uuid: buildDeliveryInputUuid("delivery-1"), message: { role: "user", content: "work" } },
      { type: "assistant", uuid: "answer", message: { role: "assistant", content: "done" } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const row = { delivery_id: "delivery-1", target_session_id: "target" } as SessionDeliveryRow;
    const redeliverContent = vi.fn();
    const markDeliveredFromTranscript = vi.fn(async () => null);
    const markConsumed = vi.fn(async () => ({ ...row, state: "consumed", aggregate_state: "consumed", target_receipt_id: "transcript:answer" } as SessionDeliveryRow));
    const { recovery } = composeQueuedDeliveryRecovery({
      sourceNode: "node-a", runnerStateDirectory: root,
      db: {
        getSession: async () => ({ session_id: "target", node_id: "node-a", agent_id: "agent", claude_session_id: "claude-session" } as SessionRow),
        sessionDeliveries: () => ({
          get: vi.fn(), markConsumed, markUncertain: vi.fn(), retryDeliveryAttempt: vi.fn(),
          recovery: { claimQueuedAfterNodeRestart: vi.fn(async () => [row]), markDeliveredFromTranscript },
        }),
      } as never,
      agentRegistry: { get: () => ({ id: "agent", name: "Claude", backend: "claude", workspace_dir: "/workspace" }) } as never,
      modelCatalog: { resolve: vi.fn() }, getTask: () => undefined,
      redeliverContent, logger: { warn: vi.fn() } as never,
    });
    await expect(recovery.recoverAfterNodeRestart("node-a")).resolves.toEqual({ claimed: 1, settled: 1 });
    expect(markDeliveredFromTranscript).toHaveBeenCalledWith("delivery-1", expect.stringMatching(/^queued-recovery:node-a:/), "answer");
    expect(markConsumed).toHaveBeenCalledOnce();
    expect(redeliverContent).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  ClaudeDeliveryTranscriptReceiptReader,
  findClaudeDeliveryTranscriptReceipt,
} from "../../src/engine/claude_delivery_transcript_receipt.js";
import type { SessionDeliveryRow, SessionRow } from
  "../../src/db/session_db_types.js";
import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";

function message(
  type: "user" | "assistant",
  uuid: string,
): SessionMessage {
  return {
    type,
    uuid,
    session_id: "claude-session",
    message: {},
    parent_tool_use_id: null,
    parent_agent_id: null,
  };
}

describe("Claude delivery transcript receipt", () => {
  it("distinguishes absent, accepted, and completed stable input UUIDs", () => {
    expect(
      findClaudeDeliveryTranscriptReceipt(
        [message("user", "other")],
        "delivery-input",
      ),
    ).toEqual({ kind: "absent", inputUuid: "delivery-input" });
    expect(
      findClaudeDeliveryTranscriptReceipt(
        [message("user", "delivery-input")],
        "delivery-input",
      ),
    ).toEqual({ kind: "input_pending", inputUuid: "delivery-input" });
    expect(
      findClaudeDeliveryTranscriptReceipt(
        [
          message("assistant", "earlier"),
          message("user", "delivery-input"),
          message("assistant", "delivery-result"),
        ],
        "delivery-input",
      ),
    ).toEqual({
      kind: "completed",
      inputUuid: "delivery-input",
      assistantMessageUuid: "delivery-result",
    });
  });

  it("does not borrow an assistant message that precedes the delivery input", () => {
    expect(
      findClaudeDeliveryTranscriptReceipt(
        [
          message("user", "seed"),
          message("assistant", "seed-result"),
          message("user", "delivery-input"),
        ],
        "delivery-input",
      ),
    ).toEqual({ kind: "input_pending", inputUuid: "delivery-input" });
  });

  it("falls back to same-node JSONL when the shared transcript mirror ended at the crash", async () => {
    const deliveryId = "delivery-stable";
    const inputUuid = buildDeliveryInputUuid(deliveryId);
    const loadMessages = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        message("user", inputUuid),
        message("assistant", "assistant-after-parent-crash"),
      ]);
    const reader = new ClaudeDeliveryTranscriptReceiptReader({
      sourceNode: "node-a",
      sessionStore: {} as never,
      getSession: async () => ({
        session_id: "target",
        node_id: "node-a",
        agent_id: "claude-agent",
        claude_session_id: "claude-session",
      } as SessionRow),
      getAgent: () => ({
        id: "claude-agent",
        name: "Claude",
        backend: "claude",
        workspace_dir: "/workspace",
      }),
      loadMessages,
    });

    await expect(reader.inspect({
      delivery_id: deliveryId,
      target_session_id: "target",
    } as SessionDeliveryRow)).resolves.toEqual({
      kind: "completed",
      inputUuid,
      assistantMessageUuid: "assistant-after-parent-crash",
    });
    expect(loadMessages).toHaveBeenCalledTimes(2);
    expect(loadMessages.mock.calls[0]?.[1]).toHaveProperty("sessionStore");
    expect(loadMessages.mock.calls[1]?.[1]).not.toHaveProperty("sessionStore");
  });

  it("uses the persisted preset backend instead of the profile fallback", async () => {
    const deliveryId = "delivery-preset-backend";
    const inputUuid = buildDeliveryInputUuid(deliveryId);
    const loadMessages = vi.fn().mockResolvedValue([
      message("user", inputUuid),
      message("assistant", "assistant-from-kimi"),
    ]);
    const reader = new ClaudeDeliveryTranscriptReceiptReader({
      sourceNode: "node-a",
      sessionStore: {} as never,
      getSession: async () => ({
        session_id: "target",
        node_id: "node-a",
        agent_id: "codex-profile",
        claude_session_id: "claude-session",
        model_preset: "kimi-2",
      } as SessionRow),
      getAgent: () => ({
        id: "codex-profile",
        name: "Codex profile",
        backend: "codex",
        workspace_dir: "/workspace",
      }),
      getModelPresetBackend: () => "claude",
      loadMessages,
    });

    await expect(reader.inspect({
      delivery_id: deliveryId,
      target_session_id: "target",
    } as SessionDeliveryRow)).resolves.toEqual({
      kind: "completed",
      inputUuid,
      assistantMessageUuid: "assistant-from-kimi",
    });
    expect(loadMessages).toHaveBeenCalledTimes(1);
  });

  it("skips Claude transcript reads for a Codex preset on a Claude profile", async () => {
    const loadMessages = vi.fn();
    const reader = new ClaudeDeliveryTranscriptReceiptReader({
      sourceNode: "node-a",
      sessionStore: {} as never,
      getSession: async () => ({
        session_id: "target",
        node_id: "node-a",
        agent_id: "claude-profile",
        claude_session_id: "codex-thread",
        model_preset: "codex-5.6-sol",
      } as SessionRow),
      getAgent: () => ({
        id: "claude-profile",
        name: "Claude profile",
        backend: "claude",
        workspace_dir: "/workspace",
      }),
      getModelPresetBackend: () => "codex",
      loadMessages,
    });

    await expect(reader.inspect({
      delivery_id: "delivery-codex",
      target_session_id: "target",
    } as SessionDeliveryRow)).resolves.toMatchObject({ kind: "absent" });
    expect(loadMessages).not.toHaveBeenCalled();
  });
});

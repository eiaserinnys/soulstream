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

function nativeTaskNotification(
  taskId = "task-native",
  toolUseId = "toolu-native",
): SessionMessage {
  return {
    ...message("user", "native-input"),
    message: {
      role: "user",
      content: `<task-notification><task-id>${taskId}</task-id>` +
        `<tool-use-id>${toolUseId}</tool-use-id><status>completed</status>` +
        `</task-notification>`,
    },
    origin: { kind: "task-notification" },
  } as SessionMessage;
}

function nativeTurnPrefix(
  taskId = "task-native",
  toolUseId = "toolu-native",
): SessionMessage[] {
  return [
    nativeTaskNotification(taskId, toolUseId),
    message("assistant", "thinking-only"),
    message("assistant", "tool-use-only"),
    {
      ...message("user", "tool-result"),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }],
      },
    } as SessionMessage,
  ];
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

  it("does not borrow an assistant from a later user turn", () => {
    expect(
      findClaudeDeliveryTranscriptReceipt(
        [
          message("user", "native-notification-input"),
          message("user", "human-successor-input"),
          message("assistant", "human-successor-answer"),
        ],
        "native-notification-input",
      ),
    ).toEqual({
      kind: "input_pending",
      inputUuid: "native-notification-input",
    });
  });

  it("selects the exact published assistant across intermediate SDK messages without crossing the next turn", () => {
    expect(findClaudeDeliveryTranscriptReceipt(
      [...nativeTurnPrefix(), message("assistant", "published-assistant")],
      "native-input",
      "published-assistant",
    )).toEqual({
      kind: "completed",
      inputUuid: "native-input",
      assistantMessageUuid: "published-assistant",
    });
  });

  it("does not select the expected assistant from beyond the next turn-starting user", () => {
    expect(findClaudeDeliveryTranscriptReceipt(
      [
        ...nativeTurnPrefix(),
        message("user", "human-successor"),
        message("assistant", "published-assistant"),
      ],
      "native-input",
      "published-assistant",
    )).toEqual({ kind: "input_pending", inputUuid: "native-input" });
  });

  it("proves the exact native task notification that owns a published assistant", async () => {
    const loadMessages = vi.fn().mockResolvedValue([
      ...nativeTurnPrefix(),
      message("assistant", "published-assistant"),
    ]);
    const reader = new ClaudeDeliveryTranscriptReceiptReader({
      sourceNode: "node-a", sessionStore: {} as never,
      getSession: async () => ({
        session_id: "target", node_id: "node-a", agent_id: "claude-agent",
        claude_session_id: "claude-session",
      } as SessionRow),
      getAgent: () => ({
        id: "claude-agent", name: "Claude", backend: "claude",
        workspace_dir: "/workspace",
      }),
      loadMessages,
    });

    await expect(reader.inspectNativeTaskNotification("target", {
      taskId: "task-native",
      initiatingToolUseId: "toolu-native",
      expectedAssistantUuid: "published-assistant",
    })).resolves.toEqual({
      kind: "completed",
      inputUuid: "native-input",
      assistantMessageUuid: "published-assistant",
    });
  });

  it.each([
    ["wrong task", nativeTurnPrefix("task-other", "toolu-native")],
    ["same task with wrong tool", nativeTurnPrefix("task-native", "toolu-other")],
    ["missing input UUID", [
      { ...nativeTaskNotification(), uuid: undefined } as unknown as SessionMessage,
      ...nativeTurnPrefix().slice(1),
    ]],
    ["next turn", [
      ...nativeTurnPrefix(),
      message("user", "human-successor"),
    ]],
  ] as const)("does not prove a published assistant owned by %s", async (_label, prefix) => {
    const loadMessages = vi.fn().mockResolvedValue([
      ...prefix,
      message("assistant", "published-assistant"),
    ]);
    const reader = new ClaudeDeliveryTranscriptReceiptReader({
      sourceNode: "node-a", sessionStore: {} as never,
      getSession: async () => ({
        session_id: "target", node_id: "node-a", agent_id: "claude-agent",
        claude_session_id: "claude-session",
      } as SessionRow),
      getAgent: () => ({
        id: "claude-agent", name: "Claude", backend: "claude",
        workspace_dir: "/workspace",
      }),
      loadMessages,
    });

    await expect(reader.inspectNativeTaskNotification("target", {
      taskId: "task-native",
      initiatingToolUseId: "toolu-native",
      expectedAssistantUuid: "published-assistant",
    })).resolves.toBeNull();
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

  it("reads the same-node native assistant when the live shared mirror has only its input", async () => {
    const loadMessages = vi.fn()
      .mockResolvedValueOnce([
        message("user", "native-input"),
        message("assistant", "thinking-only"),
      ])
      .mockResolvedValueOnce([
        ...nativeTurnPrefix(),
        message("assistant", "native-assistant"),
      ]);
    const reader = new ClaudeDeliveryTranscriptReceiptReader({
      sourceNode: "node-a", sessionStore: {} as never,
      getSession: async () => ({
        session_id: "target", node_id: "node-a", agent_id: "claude-agent",
        claude_session_id: "claude-session",
      } as SessionRow),
      getAgent: () => ({
        id: "claude-agent", name: "Claude", backend: "claude",
        workspace_dir: "/workspace",
      }),
      loadMessages,
    });

    await expect(reader.inspectInput(
      "target",
      "native-input",
      "native-assistant",
    )).resolves.toEqual({
      kind: "completed", inputUuid: "native-input",
      assistantMessageUuid: "native-assistant",
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

import { describe, expect, it } from "vitest";

import { STATUS_CONFIG } from "../SessionItem";
import { resolveChatInputMode } from "./chatInputMode";
import { CHAT_STATUS_TONE_CONFIG } from "./chat-tone-config";

describe("chat tone config", () => {
  it("preserves status labels while using calm chat tone classes", () => {
    expect(CHAT_STATUS_TONE_CONFIG.running.label).toBe(STATUS_CONFIG.running.label);
    expect(CHAT_STATUS_TONE_CONFIG.running.chipClass).toBe("chat-tone-success");
    expect(CHAT_STATUS_TONE_CONFIG.running.dotClass).toBe("chat-tone-success-dot");

    expect(CHAT_STATUS_TONE_CONFIG.error.label).toBe(STATUS_CONFIG.error.label);
    expect(CHAT_STATUS_TONE_CONFIG.error.chipClass).toBe("chat-tone-danger");
    expect(CHAT_STATUS_TONE_CONFIG.error.dotClass).toBe("chat-tone-danger-dot");

    expect(CHAT_STATUS_TONE_CONFIG.interrupted.label).toBe(STATUS_CONFIG.interrupted.label);
    expect(CHAT_STATUS_TONE_CONFIG.interrupted.chipClass).toBe("chat-tone-warning");
    expect(CHAT_STATUS_TONE_CONFIG.interrupted.dotClass).toBe("chat-tone-warning-dot");

    expect(CHAT_STATUS_TONE_CONFIG.completed).toBe(STATUS_CONFIG.completed);
  });

  it("returns calm success and intervention classes for chat input modes", () => {
    expect(resolveChatInputMode({
      isFinished: true,
      isLlmFinished: true,
      sending: false,
      ctxCount: 2,
    })).toMatchObject({
      modeLabel: "LLM (2 ctx)",
      borderColor: "chat-focus-success",
      buttonVariant: "success",
    });

    expect(resolveChatInputMode({
      isFinished: false,
      isLlmFinished: false,
      sending: false,
      ctxCount: 0,
    })).toMatchObject({
      modeLabel: "Intervention",
      borderColor: "chat-focus-warning",
      buttonVariant: "warning",
    });
  });
});

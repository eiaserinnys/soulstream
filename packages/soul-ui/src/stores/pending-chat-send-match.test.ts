import { describe, expect, it } from "vitest";
import type { SoulSSEEvent } from "@shared/types";
import type { PendingChatSend } from "./dashboard-store-types";
import { ATTACHMENT_PATH_NOTE_PREFIX } from "../lib/attachment-path-notes";
import { pendingChatSendMatchesEvent } from "./pending-chat-send-match";

const attachmentPath = "/tmp/scene.png";
const messageText = "처리해 주세요";

function pendingSend(
  text: string,
  attachmentPaths: string[] = [],
): PendingChatSend {
  return {
    id: "pending-1",
    status: "sending",
    text: messageText,
    messageText: text,
    attachmentPaths,
    attachments: [],
    mode: "intervention",
  };
}

function event(value: Record<string, unknown>): SoulSSEEvent {
  return value as unknown as SoulSSEEvent;
}

describe("pendingChatSendMatchesEvent", () => {
  it("matches equal text without attachments", () => {
    expect(pendingChatSendMatchesEvent(pendingSend(messageText), event({
      type: "user_message",
      text: messageText,
    }))).toBe(true);
  });

  it("does not match different text without attachments", () => {
    expect(pendingChatSendMatchesEvent(pendingSend(messageText), event({
      type: "user_message",
      text: "다른 메시지",
    }))).toBe(false);
  });

  it("matches a server-shaped event with its attachment paths in attachments", () => {
    expect(pendingChatSendMatchesEvent(
      pendingSend(`${messageText}\n\n${ATTACHMENT_PATH_NOTE_PREFIX}${attachmentPath}]`, [attachmentPath]),
      event({
        type: "user_message",
        user: "director",
        text: messageText,
        context: [{
          key: "persistent_report_visible",
          content: { key: "card-example", title: "보고서" },
        }],
        input_id: "input-example",
        timestamp: 1_790_000_000,
        attachments: [attachmentPath],
        attachment_ids: ["attachment-example"],
        attachment_count: 1,
      }),
    )).toBe(true);
  });

  it("matches an older event whose text still contains the path note", () => {
    const textWithPath = `${messageText}\n\n${ATTACHMENT_PATH_NOTE_PREFIX}${attachmentPath}]`;
    expect(pendingChatSendMatchesEvent(
      pendingSend(textWithPath, [attachmentPath]),
      event({ type: "intervention_sent", text: textWithPath }),
    )).toBe(true);
  });

  it("matches attachment paths as a set regardless of order or duplicates", () => {
    const otherPath = "/tmp/diagram.png";
    const pending = pendingSend(messageText, [attachmentPath, otherPath]);
    expect(pendingChatSendMatchesEvent(pending, event({
      type: "user_message",
      text: messageText,
      attachments: [otherPath, attachmentPath, attachmentPath],
    }))).toBe(true);
  });

  it("does not match when attachment paths differ", () => {
    expect(pendingChatSendMatchesEvent(
      pendingSend(`${messageText}\n\n${ATTACHMENT_PATH_NOTE_PREFIX}${attachmentPath}]`, [attachmentPath]),
      event({ type: "user_message", text: messageText, attachments: ["/tmp/other.png"] }),
    )).toBe(false);
  });

  it("does not match when the body differs after removing path notes", () => {
    expect(pendingChatSendMatchesEvent(
      pendingSend(`${messageText}\n\n${ATTACHMENT_PATH_NOTE_PREFIX}${attachmentPath}]`, [attachmentPath]),
      event({ type: "user_message", text: "다른 메시지", attachments: [attachmentPath] }),
    )).toBe(false);
  });

  it("does not match when the event has no string attachment array", () => {
    const pending = pendingSend(
      `${messageText}\n\n${ATTACHMENT_PATH_NOTE_PREFIX}${attachmentPath}]`,
      [attachmentPath],
    );
    expect(pendingChatSendMatchesEvent(pending, event({
      type: "user_message",
      text: messageText,
    }))).toBe(false);
    expect(pendingChatSendMatchesEvent(pending, event({
      type: "user_message",
      text: messageText,
      attachments: [attachmentPath, 1],
    }))).toBe(false);
  });

  it("does not match a non-string event body", () => {
    expect(pendingChatSendMatchesEvent(
      pendingSend(`${messageText}\n\n${ATTACHMENT_PATH_NOTE_PREFIX}${attachmentPath}]`, [attachmentPath]),
      event({ type: "user_message", text: 1, attachments: [attachmentPath] }),
    )).toBe(false);
  });

  it("does not match another event type", () => {
    expect(pendingChatSendMatchesEvent(pendingSend(messageText), event({
      type: "assistant_message",
      text: messageText,
    }))).toBe(false);
  });
});

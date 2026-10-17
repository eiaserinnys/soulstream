import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./flatten-tree";
import { projectChatOutputAttachments } from "./chat-output-attachment-projection";

function message(
  id: string,
  role: ChatMessage["role"],
  treeNodeType: string,
  eventId: number,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content: id,
    treeNodeId: id,
    treeNodeType,
    eventId,
    ...extra,
  } as ChatMessage;
}

function assistant(id: string, eventId: number, attachmentIds: string[]): ChatMessage {
  return message(id, "assistant", "assistant_message", eventId, { content: "", attachmentIds });
}

function complete(id: string, eventId: number, attachmentIds: string[], captionStats = "비용") {
  return message(id, "system", "complete", eventId, {
    content: "완료",
    attachmentIds,
    captionStats,
    turnCostUsd: 0.25,
    sessionCostUsd: 0.75,
  });
}

describe("projectChatOutputAttachments", () => {
  it("creates an assistant attachment-only row for complete-only IDs immediately before the original complete", () => {
    const sourceComplete = complete("complete-1", 11, ["asset-a", "asset-b"]);

    const projected = projectChatOutputAttachments([sourceComplete]);

    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({
      id: "output-attachments:11",
      role: "assistant",
      content: "",
      eventId: 11,
      attachmentIds: ["asset-a", "asset-b"],
      attachmentDisplayIds: ["asset-a", "asset-b"],
      treeNodeId: "output-attachments:11",
      treeNodeType: "assistant_message",
    });
    expect(projected[1]).toBe(sourceComplete);
    expect(projected[1]?.captionStats).toBe("비용");
    expect(projected[1]?.turnCostUsd).toBe(0.25);
  });

  it("keeps complete IDs as the lookup reference while allowing only IDs not already shown in that turn", () => {
    const response = assistant("response-1", 10, ["asset-a", "asset-b"]);
    const sourceComplete = complete("complete-1", 11, ["asset-a", "asset-b"]);

    const projected = projectChatOutputAttachments([response, sourceComplete]);

    expect(projected).toHaveLength(3);
    expect(projected[0]).toBe(response);
    expect(projected[1]).toMatchObject({
      id: "output-attachments:11",
      eventId: 11,
      attachmentIds: ["asset-a", "asset-b"],
      attachmentDisplayIds: [],
    });
    expect(projected[2]).toBe(sourceComplete);
  });

  it("deduplicates the IDs already shown by multiple assistant events but retains new IDs in source order", () => {
    const firstResponse = assistant("response-1", 10, ["asset-a", "asset-b"]);
    const secondResponse = assistant("response-2", 12, ["asset-b", "asset-c"]);
    const sourceComplete = complete("complete-1", 13, ["asset-c", "asset-b", "asset-d"]);

    const projected = projectChatOutputAttachments([firstResponse, secondResponse, sourceComplete]);

    expect(projected[2]).toMatchObject({
      id: "output-attachments:13",
      attachmentIds: ["asset-c", "asset-b", "asset-d"],
      attachmentDisplayIds: ["asset-d"],
    });
    expect(projected[3]).toBe(sourceComplete);
  });

  it("resets the seen-ID boundary at each complete and generation start", () => {
    const firstResponse = assistant("response-1", 10, ["same-asset"]);
    const firstComplete = complete("complete-1", 11, ["same-asset"]);
    const generation = message("generation-2", "system", "generation_started", 12);
    const secondResponse = assistant("response-2", 13, ["same-asset"]);
    const secondComplete = complete("complete-2", 14, ["same-asset"]);

    const projected = projectChatOutputAttachments([
      firstResponse,
      firstComplete,
      generation,
      secondResponse,
      secondComplete,
    ]);

    expect(projected.filter((item) => item.id.startsWith("output-attachments:"))).toHaveLength(2);
    expect(projected.find((item) => item.id === "output-attachments:11")?.attachmentDisplayIds).toEqual([]);
    expect(projected.find((item) => item.id === "output-attachments:14")?.attachmentDisplayIds).toEqual([]);
  });

  it("does not add rows to attachment-free completes and is deterministic when the full history is rebuilt", () => {
    const history = [
      assistant("response-1", 10, ["asset-a"]),
      complete("complete-1", 11, ["asset-a"]),
      assistant("response-2", 20, ["asset-a"]),
      complete("complete-2", 21, []),
    ];

    expect(projectChatOutputAttachments(history)).toEqual(projectChatOutputAttachments(history));
    expect(projectChatOutputAttachments(history).filter((item) => item.id.startsWith("output-attachments:"))).toHaveLength(1);
  });
});

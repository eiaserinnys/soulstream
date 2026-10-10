import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./flatten-tree";
import { flattenTree } from "./flatten-tree";
import { projectManuscriptMessages } from "./manuscript-agent-message-projection";
import { createNodeFromEvent } from "../stores/node-factory";
import type { EventTreeNode, SoulSSEEvent } from "../shared/types";

function message(
  id: string,
  role: ChatMessage["role"],
  source?: NonNullable<ChatMessage["callerInfo"]>["source"],
): ChatMessage {
  return {
    id,
    role,
    content: id,
    treeNodeId: id,
    treeNodeType: role === "intervention"
      ? "intervention"
      : role === "notification"
        ? "session_notification"
        : role === "system"
          ? "system_message"
          : role === "assistant"
            ? "text"
            : "user_message",
    callerInfo: source ? { source } : undefined,
  };
}

describe("projectManuscriptMessages", () => {
  it("hides automatic notices by intent regardless of disposition or producer source", () => {
    const queuedCompletion = {
      ...message("queued-completion", "notification"),
      deliveryIntent: "completion_notification" as const,
      deliveryDisposition: "queued" as const,
      source: "future_completion_producer",
    };
    const resumedFollowup = {
      ...message("resumed-followup", "notification"),
      deliveryIntent: "runtime_followup" as const,
      deliveryDisposition: "auto_resume" as const,
      source: "future_runtime_producer",
    };
    const unrelatedNotice = message("unrelated-notice", "notification");

    expect(projectManuscriptMessages([
      queuedCompletion,
      resumedFollowup,
      unrelatedNotice,
    ])).toEqual([unrelatedNotice]);
  });

  it("hides agent reports and preserves people, assistant output, and other rows by reference", () => {
    const legacyAgentInfo: NonNullable<ChatMessage["agentInfo"]> = {
      source: "agent",
      agent_node: "eiaserinnys",
      agent_id: "roselin",
      agent_name: "로젤린",
    };
    const agentUser = message("agent-user", "user", "agent");
    const agentIntervention = message("agent-intervention", "intervention", "agent");
    const legacyAgentUser = { ...message("legacy-agent-user", "user"), agentInfo: legacyAgentInfo };
    const legacyAgentIntervention = {
      ...message("legacy-agent-intervention", "intervention"),
      agentInfo: legacyAgentInfo,
    };
    const callerInfoWins = {
      ...message("person-with-legacy-projection", "user", "browser"),
      agentInfo: legacyAgentInfo,
      attachmentPaths: ["/image.png"],
    };
    const person = {
      ...message("person", "user", "soul-app"),
      attachmentPaths: ["/attachment.png"],
    };
    const assistant = message("assistant", "assistant");
    const system = message("system", "system");
    const question = message("question", "input_request");
    const unrelatedNotice = message("unrelated-notice", "notification");
    const messages = [
      agentUser,
      person,
      agentIntervention,
      legacyAgentUser,
      callerInfoWins,
      legacyAgentIntervention,
      assistant,
      system,
      question,
      unrelatedNotice,
    ];

    const projected = projectManuscriptMessages(messages);

    expect(projected).toEqual([
      person,
      callerInfoWins,
      legacyAgentIntervention,
      assistant,
      system,
      question,
      unrelatedNotice,
    ]);
    expect(projected[0]).toBe(person);
    expect(projected[0]?.attachmentPaths).toBe(person.attachmentPaths);
    expect(projected[1]).toBe(callerInfoWins);
    expect(projected[1]?.attachmentPaths).toBe(callerInfoWins.attachmentPaths);
    expect(projected.some(row => row.treeNodeType === "manuscript_agent_message_group")).toBe(false);
  });

  it("keeps delivery intent and source on flattened notifications for presentation-specific filtering", () => {
    const notification = createNodeFromEvent({
      type: "session_notification",
      delivery_id: "delivery-1",
      delivery_intent: "completion_notification",
      source: "completion_notifier",
      text: "완료 결과",
      disposition: "queued",
      timestamp: 100,
    } as SoulSSEEvent, 101);
    const root = {
      id: "session",
      type: "session",
      children: [notification!],
      content: "",
      completed: false,
    } as EventTreeNode;

    const [flattened] = flattenTree(root);

    expect(flattened).toMatchObject({
      role: "notification",
      deliveryIntent: "completion_notification",
      source: "completion_notifier",
      deliveryDisposition: "queued",
    });
  });

  it("uses caller_info over the legacy user_message agent projection", () => {
    const caller_info = {
      source: "browser" as const,
      display_name: "사용자",
    };
    const user = createNodeFromEvent({
      type: "user_message",
      text: "사람 입력",
      source: "agent",
      caller_info,
    } as SoulSSEEvent, 102);
    const root = {
      id: "session",
      type: "session",
      children: [user!],
      content: "",
      completed: false,
    } as EventTreeNode;

    expect(projectManuscriptMessages(flattenTree(root))).toEqual([
      expect.objectContaining({
        role: "user",
        callerInfo: caller_info,
        agentInfo: undefined,
      }),
    ]);
  });
});

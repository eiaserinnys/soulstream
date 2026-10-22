import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./flatten-tree";
import { flattenTree } from "./flatten-tree";
import {
  isManuscriptSilentTokenText,
  isStandaloneKoreanYesAck,
  projectManuscriptMessages,
  projectManuscriptSilentResponses,
} from "./manuscript-agent-message-projection";
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

  it("recognizes only the dedicated silence token and standalone Korean acknowledgements", () => {
    expect(isManuscriptSilentTokenText(" [SILENT] ")).toBe(true);
    expect(isManuscriptSilentTokenText(" [SIL", true)).toBe(true);
    expect(isManuscriptSilentTokenText("[SIL", false)).toBe(false);
    expect(isManuscriptSilentTokenText("일반 답변", true)).toBe(false);

    expect(isStandaloneKoreanYesAck(" 네. ")).toBe(true);
    expect(isStandaloneKoreanYesAck("네")).toBe(true);
    expect(isStandaloneKoreanYesAck("네, 확인했습니다.")).toBe(false);
  });

  it("hides silence and standalone acknowledgements only for suppressed turns without attachments", () => {
    const agentInput = message("agent-input", "user", "agent");
    const agentGeneration = { ...message("agent-generation", "system"), treeNodeType: "generation_started" };
    const agentAck = { ...message("agent-ack", "assistant"), content: " 네. " };
    const agentSilent = { ...message("agent-silent", "assistant"), content: " [SILENT] " };
    const agentReply = { ...message("agent-reply", "assistant"), content: "확인한 내용을 전달합니다." };
    const attachedAck = {
      ...message("attached-ack", "assistant"),
      content: "네.",
      attachmentPaths: ["/report.png"],
    };
    const closedInput = {
      ...message("closed-input", "user", "browser"),
      contextItems: [{ key: "persistent_report_closed", label: "보고 닫힘", content: "닫힘" }],
    };
    const closedGeneration = { ...message("closed-generation", "system"), treeNodeType: "generation_started" };
    const closedAck = { ...message("closed-ack", "assistant"), content: "네" };
    const keepaliveInput = {
      ...message("keepalive-input", "user", "browser"),
      purpose: "cache_keepalive",
    } as ChatMessage;
    const keepaliveGeneration = { ...message("keepalive-generation", "system"), treeNodeType: "generation_started" };
    const keepaliveAck = { ...message("keepalive-ack", "assistant"), content: "네." };
    const humanInput = message("human-input", "user", "browser");
    const humanAck = { ...message("human-ack", "assistant"), content: "네." };
    const attachedSilent = {
      ...message("attached-silent", "assistant"),
      content: "[SILENT]",
      outputAttachments: [{ id: "output-1" }],
    } as ChatMessage;
    const messages = [
      agentInput,
      agentGeneration,
      agentAck,
      agentSilent,
      attachedAck,
      attachedSilent,
      agentReply,
      closedInput,
      closedGeneration,
      closedAck,
      keepaliveInput,
      keepaliveGeneration,
      keepaliveAck,
      humanInput,
      humanAck,
    ];

    expect(projectManuscriptSilentResponses(messages)).toEqual([
      agentInput,
      agentGeneration,
      attachedAck,
      attachedSilent,
      agentReply,
      closedInput,
      closedGeneration,
      keepaliveInput,
      keepaliveGeneration,
      humanInput,
      humanAck,
    ]);
  });

  it("hides durable assistant history responses and preserves canonical attachment signals", () => {
    const agentInput = message("history-agent-input", "user", "agent");
    const historySilent = {
      ...message("history-silent", "assistant"),
      content: "[SILENT]",
      treeNodeType: "assistant_message",
    };
    const closedInput = {
      ...message("history-closed-input", "user", "browser"),
      contextItems: [{ key: "persistent_report_closed", label: "보고 닫힘", content: "닫힘" }],
    };
    const historyAck = {
      ...message("history-ack", "assistant"),
      content: "네.",
      treeNodeType: "assistant_message",
    };
    const attachedByIds = {
      ...message("attached-by-ids", "assistant"),
      content: "[SILENT]",
      attachmentIds: ["attachment-1"],
    };
    const attachedByCount = {
      ...message("attached-by-count", "assistant"),
      content: "네.",
      attachmentCount: 1,
    };

    expect(projectManuscriptSilentResponses([
      agentInput,
      historySilent,
      closedInput,
      historyAck,
      attachedByIds,
      attachedByCount,
    ])).toEqual([agentInput, closedInput, attachedByIds, attachedByCount]);
  });

  it("hides a standalone acknowledgement after an automatic delivery notice", () => {
    const notice = {
      ...message("notice", "notification"),
      deliveryIntent: "completion_notification" as const,
    };
    const generation = { ...message("notice-generation", "system"), treeNodeType: "generation_started" };
    const ack = { ...message("notice-ack", "assistant"), content: "네." };

    expect(projectManuscriptSilentResponses([notice, generation, ack])).toEqual([notice, generation]);
    expect(projectManuscriptMessages([notice, generation, ack])).toEqual([generation]);
  });

  it("hides end captions when hidden opener rows have no surviving answer or error", () => {
    const agentInput = message("hidden-agent-input", "user", "agent");
    const generation = { ...message("hidden-generation", "system"), treeNodeType: "generation_started" };
    const notice = {
      ...message("hidden-notice", "notification"),
      deliveryIntent: "completion_notification" as const,
    };
    const silentHistoryResponse = {
      ...message("hidden-silent-history", "assistant"),
      content: "[SILENT]",
      treeNodeType: "assistant_message",
    };
    const captions = [
      { ...message("hidden-complete", "system"), treeNodeType: "complete" },
      { ...message("hidden-context", "system"), treeNodeType: "context_usage" },
      { ...message("hidden-summary", "system"), treeNodeType: "turn_summary" },
      { ...message("hidden-instruction", "system"), treeNodeType: "persistent_instruction_recorded" },
      { ...message("hidden-jev", "system"), treeNodeType: "persistent_jev_candidates" },
    ];
    const messages = [agentInput, generation, notice, silentHistoryResponse, ...captions];

    expect(projectManuscriptSilentResponses(messages)).toEqual([agentInput, generation, notice]);
    expect(projectManuscriptMessages(messages)).toEqual([generation]);
  });

  it("keeps end captions when a visible input, surviving answer, or error remains", () => {
    const agentInput = message("answer-agent-input", "user", "agent");
    const agentAnswer = { ...message("answer-agent-reply", "assistant"), content: "확인한 내용을 전달합니다." };
    const agentComplete = { ...message("answer-agent-complete", "system"), treeNodeType: "complete" };
    const humanInput = message("human-silent-input", "user", "browser");
    const humanGeneration = { ...message("human-silent-generation", "system"), treeNodeType: "generation_started" };
    const humanSilent = { ...message("human-silent-response", "assistant"), content: "[SILENT]" };
    const humanComplete = { ...message("human-silent-complete", "system"), treeNodeType: "complete" };
    const closedInput = {
      ...message("closed-silent-input", "user", "browser"),
      contextItems: [{ key: "persistent_report_closed", label: "보고 닫힘", content: "닫힘" }],
    };
    const closedGeneration = { ...message("closed-silent-generation", "system"), treeNodeType: "generation_started" };
    const closedSilent = { ...message("closed-silent-response", "assistant"), content: "네." };
    const closedComplete = { ...message("closed-silent-complete", "system"), treeNodeType: "complete" };
    const errorInput = message("error-agent-input", "user", "agent");
    const error = { ...message("agent-error", "system"), treeNodeType: "error" };
    const errorComplete = { ...message("agent-error-complete", "system"), treeNodeType: "complete" };

    expect(projectManuscriptMessages([
      agentInput,
      agentAnswer,
      agentComplete,
      humanInput,
      humanGeneration,
      humanSilent,
      humanComplete,
      closedInput,
      closedGeneration,
      closedSilent,
      closedComplete,
      errorInput,
      error,
      errorComplete,
    ])).toEqual([
      agentAnswer,
      agentComplete,
      humanInput,
      humanGeneration,
      humanComplete,
      closedInput,
      closedGeneration,
      closedComplete,
      error,
      errorComplete,
    ]);
  });
});

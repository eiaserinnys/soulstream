import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./flatten-tree";
import { flattenTree } from "./flatten-tree";
import { projectManuscriptAgentMessages } from "./manuscript-agent-message-projection";
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
    treeNodeType: role === "intervention" ? "intervention" : "user_message",
    callerInfo: source ? { source } : undefined,
  };
}

describe("projectManuscriptAgentMessages", () => {
  it("groups three consecutive agent messages into one row", () => {
    const [group] = projectManuscriptAgentMessages([
      message("agent-1", "user", "agent"),
      message("agent-2", "intervention", "agent"),
      message("agent-3", "user", "agent"),
    ]);

    expect(group).toMatchObject({
      id: "manuscript-agent-group-agent-1",
      role: "system",
      treeNodeType: "manuscript_agent_message_group",
      manuscriptAgentMessages: [
        { id: "agent-1" }, { id: "agent-2" }, { id: "agent-3" },
      ],
    });
  });

  it("starts a new group after a visible human message", () => {
    const rows = projectManuscriptAgentMessages([
      message("agent-1", "user", "agent"),
      message("human", "user", "browser"),
      message("agent-2", "intervention", "agent"),
      message("agent-3", "user", "agent"),
    ]);

    expect(rows.map(row => row.id)).toEqual([
      "manuscript-agent-group-agent-1",
      "human",
      "manuscript-agent-group-agent-2",
    ]);
    expect(rows[0]?.manuscriptAgentMessages).toHaveLength(1);
    expect(rows[2]?.manuscriptAgentMessages).toHaveLength(2);
  });

  it("adds a late agent message to the last group without changing its row identity", () => {
    const firstPass = projectManuscriptAgentMessages([
      message("agent-1", "user", "agent"),
      message("human", "user", "soul-app"),
      message("agent-2", "intervention", "agent"),
    ]);
    const updated = projectManuscriptAgentMessages([
      message("agent-1", "user", "agent"),
      message("human", "user", "soul-app"),
      message("agent-2", "intervention", "agent"),
      message("agent-3", "user", "agent"),
    ]);

    expect(updated.at(-1)?.id).toBe(firstPass.at(-1)?.id);
    expect(updated.at(-1)?.manuscriptAgentMessages?.map(row => row.id)).toEqual([
      "agent-2", "agent-3",
    ]);
  });

  it("keeps people and non-agent sources as individual rows", () => {
    const person = message("person", "user", "slack");
    const system = message("system", "intervention", "system");
    const missingSource = message("missing-source", "user");

    expect(projectManuscriptAgentMessages([person, system, missingSource]))
      .toEqual([person, system, missingSource]);
  });

  it("preserves agent caller_info from user and intervention events through the tree projection", () => {
    const caller_info = {
      source: "agent" as const,
      agent_node: "eiaserinnys",
      agent_id: "roselin",
      agent_name: "로젤린",
    };
    const user = createNodeFromEvent({
      type: "user_message",
      text: "위임 보고",
      caller_info,
    } as SoulSSEEvent, 101);
    const intervention = createNodeFromEvent({
      type: "intervention_sent",
      user: "roselin",
      text: "개입 전달",
      caller_info,
    } as SoulSSEEvent, 102);
    const root = {
      id: "session",
      type: "session",
      children: [user!, intervention!],
      content: "",
      completed: false,
    } as EventTreeNode;

    const [group] = projectManuscriptAgentMessages(flattenTree(root));
    expect(group?.manuscriptAgentMessages?.map(message => message.callerInfo?.source))
      .toEqual(["agent", "agent"]);
  });
});

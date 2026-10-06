import { useState } from "react";
import { ManuscriptAgentMessageGroup, ManuscriptAgentMessageGroupView } from "@seosoyoung/soul-ui/components/chat/ManuscriptAgentMessageGroup";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";

const messages: ChatMessage[] = [
  {
    id: "review-agent-report-1",
    role: "user",
    content: "첫 번째 위임 보고입니다.",
    treeNodeId: "review-agent-report-1",
    treeNodeType: "user_message",
    callerInfo: { source: "agent", agent_node: "eiaserinnys", agent_id: "roselin", agent_name: "로젤린" },
    agentInfo: { source: "agent", agent_node: "eiaserinnys", agent_id: "roselin", agent_name: "로젤린" },
  },
  {
    id: "review-agent-intervention",
    role: "intervention",
    content: "두 번째 메시지는 개입 전달입니다.",
    treeNodeId: "review-agent-intervention",
    treeNodeType: "intervention",
    callerInfo: { source: "agent", agent_node: "eiaserinnys", agent_id: "roselin", agent_name: "로젤린" },
    agentInfo: { source: "agent", agent_node: "eiaserinnys", agent_id: "roselin", agent_name: "로젤린" },
  },
  {
    id: "review-agent-report-3",
    role: "user",
    content: "세 번째 위임 보고입니다.",
    treeNodeId: "review-agent-report-3",
    treeNodeType: "user_message",
    callerInfo: { source: "agent", agent_node: "eiaserinnys", agent_id: "roselin", agent_name: "로젤린" },
    agentInfo: { source: "agent", agent_node: "eiaserinnys", agent_id: "roselin", agent_name: "로젤린" },
  },
];

function ExpandedSample() {
  const [expanded, setExpanded] = useState(true);
  return <ManuscriptAgentMessageGroupView
    messages={messages}
    expanded={expanded}
    onToggle={() => setExpanded(value => !value)}
  />;
}

export function PersistentAgentMessageGroupReviewSample() {
  return <div className="space-y-2" data-testid="persistent-agent-message-group-review">
    <div data-testid="agent-message-group-collapsed">
      <p className="v3-components-label">접힘</p>
      <ManuscriptAgentMessageGroup messages={messages} />
    </div>
    <div data-testid="agent-message-group-expanded">
      <p className="v3-components-label">펼침</p>
      <ExpandedSample />
    </div>
  </div>;
}

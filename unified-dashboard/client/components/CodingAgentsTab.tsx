import { findUsageSummaryNode, useAuth } from "@seosoyoung/soul-ui";
import type { OrchestratorNode } from "../store/orchestrator-store";
import { useUsageSummary } from "../hooks/useUsageSummary";
import { NodeProvidersPanel } from "./NodeProvidersPanel";
import {
  SettingsAlert,
  SettingsDetailHeader,
  SettingsListDetailFrame,
} from "./config/SettingsListDetail";
import { SettingsNodeList, useSettingsNodeSelection } from "./config/SettingsNodeList";

/**
 * 「코딩 에이전트」 설정 탭. 노드 목록에서 노드를 고르면 상세에 그 노드의 공급자 행(노드 탭의 행과 같은 부품)이 놓인다.
 * 열면 연결된 첫 노드(연결된 노드가 없으면 첫 노드)가 골라져 있어 상세가 비어 있지 않다.
 * Claude는 계정 풀 로그인을, Codex와 Antigravity는 행의 「연결」 단추로 화면 로그인을 쓴다.
 */
export function CodingAgentsTab({ request, sampleNodes }: {
  request?: typeof fetch;
  sampleNodes?: Map<string, OrchestratorNode>;
}) {
  const { user } = useAuth();
  const { nodeList, selectedId, selected, select } = useSettingsNodeSelection(sampleNodes);
  const send = request ?? fetch;
  const usage = useUsageSummary({
    enabled: selectedId !== null,
    nodeId: selectedId,
    selectedNodeId: selectedId,
    scopeKey: `coding-agents|${user?.email ?? "anonymous"}`,
    request: send,
  });
  const summaryNode = findUsageSummaryNode(usage.summary, selectedId);

  return <SettingsListDetailFrame testId="coding-agents-tab" list={<SettingsNodeList description="코딩 에이전트를 연결할 노드" nodeList={nodeList} selectedId={selectedId} onSelect={select} />}>
    {selected ? <>
      <SettingsDetailHeader title={selected.nodeId} />
      {selected.status === "connected"
        ? <NodeProvidersPanel nodeId={selected.nodeId} request={send} node={summaryNode} loading={usage.loading && summaryNode === null} onUsageChanged={usage.retry} />
        : <SettingsAlert><span data-v3-selectable-content="true">노드가 연결되어 있지 않아 로그인할 수 없습니다.</span></SettingsAlert>}
    </> : null}
  </SettingsListDetailFrame>;
}

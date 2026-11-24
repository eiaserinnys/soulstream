import { useMemo, useState } from "react";
import { findUsageSummaryNode, useAuth } from "@seosoyoung/soul-ui";
import { useOrchestratorStore, type OrchestratorNode } from "../store/orchestrator-store";
import { useUsageSummary } from "../hooks/useUsageSummary";
import { NodeProvidersPanel } from "./NodeProvidersPanel";
import {
  SettingsAlert,
  SettingsDetailHeader,
  SettingsListDetailFrame,
  SettingsListHeader,
  SettingsListRow,
  SettingsListSection,
} from "./config/SettingsListDetail";

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
  const storedNodes = useOrchestratorStore((state) => state.nodes);
  const nodes = sampleNodes ?? storedNodes;
  const nodeList = useMemo(() => Array.from(nodes.values()), [nodes]);
  const [chosen, setChosen] = useState<string | null>(null);
  // 고른 노드가 없으면(또는 사라졌으면) 연결된 첫 노드, 그것도 없으면 첫 노드를 고른 채로 둔다.
  const defaultNode = nodeList.find((node) => node.status === "connected") ?? nodeList[0] ?? null;
  const selectedId = chosen && nodes.has(chosen) ? chosen : defaultNode?.nodeId ?? null;
  const selected = selectedId ? nodes.get(selectedId) ?? null : null;
  const send = request ?? fetch;
  const usage = useUsageSummary({
    enabled: selectedId !== null,
    nodeId: selectedId,
    selectedNodeId: selectedId,
    scopeKey: `coding-agents|${user?.email ?? "anonymous"}`,
    request: send,
  });
  const summaryNode = findUsageSummaryNode(usage.summary, selectedId);

  return <SettingsListDetailFrame testId="coding-agents-tab" list={<>
    <SettingsListHeader title="노드" description="코딩 에이전트를 연결할 노드" actions={null} />
    <SettingsListSection isEmpty={nodeList.length === 0} emptyText="연결된 노드가 없습니다.">
      {nodeList.map((node) => <SettingsListRow
        key={node.nodeId}
        title={node.nodeId}
        meta={node.status === "connected" ? "연결됨" : "연결 끊김"}
        selected={node.nodeId === selectedId}
        onSelect={() => setChosen(node.nodeId)}
      />)}
    </SettingsListSection>
  </>}>
    {selected ? <>
      <SettingsDetailHeader title={selected.nodeId} />
      {selected.status === "connected"
        ? <NodeProvidersPanel nodeId={selected.nodeId} request={send} node={summaryNode} loading={usage.loading && summaryNode === null} onUsageChanged={usage.retry} />
        : <SettingsAlert><span data-v3-selectable-content="true">노드가 연결되어 있지 않아 로그인할 수 없습니다.</span></SettingsAlert>}
    </> : null}
  </SettingsListDetailFrame>;
}

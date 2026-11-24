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
 * 「코딩 에이전트」 설정 탭. 왼쪽에서 노드를 고르면 오른쪽에 그 노드의 공급자 행(노드 탭의 행과 같은 부품)이 놓인다.
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
  // 노드가 하나면 처음부터 그 노드를 고른 채로 연다.
  const selectedId = chosen && nodes.has(chosen) ? chosen : nodeList.length === 1 ? nodeList[0]!.nodeId : null;
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
      <SettingsDetailHeader title={selected.nodeId} subtitle="이 노드에서 쓸 코딩 에이전트 로그인" />
      {selected.status === "connected"
        ? <NodeProvidersPanel nodeId={selected.nodeId} request={send} node={summaryNode} loading={usage.loading && summaryNode === null} onUsageChanged={usage.retry} />
        : <SettingsAlert><span data-v3-selectable-content="true">노드가 연결되어 있지 않아 로그인할 수 없습니다.</span></SettingsAlert>}
    </> : <p className="text-sm text-muted-foreground" data-testid="coding-agents-pick-node">왼쪽에서 노드를 고르세요.</p>}
  </SettingsListDetailFrame>;
}

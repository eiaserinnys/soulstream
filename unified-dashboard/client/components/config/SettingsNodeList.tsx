import { useTranslation } from "react-i18next";
import { useMemo, useState } from "react";
import { useOrchestratorStore, type OrchestratorNode } from "../../store/orchestrator-store";
import { SettingsListHeader, SettingsListRow, SettingsListSection } from "./SettingsListDetail";

/**
 * 노드를 고르는 설정 탭(코딩 에이전트 연결, Git과 저장소)이 함께 쓰는 선택 상태.
 * 고른 노드가 없으면(또는 사라졌으면) 연결된 첫 노드, 그것도 없으면 첫 노드를 고른 채로 둔다.
 */
export function useSettingsNodeSelection(sampleNodes?: Map<string, OrchestratorNode>) {
  const storedNodes = useOrchestratorStore((state) => state.nodes);
  const nodes = sampleNodes ?? storedNodes;
  const nodeList = useMemo(() => Array.from(nodes.values()), [nodes]);
  const [chosen, setChosen] = useState<string | null>(null);
  const defaultNode = nodeList.find((node) => node.status === "connected") ?? nodeList[0] ?? null;
  const selectedId = chosen && nodes.has(chosen) ? chosen : defaultNode?.nodeId ?? null;
  const selected = selectedId ? nodes.get(selectedId) ?? null : null;
  return { nodeList, selectedId, selected, select: setChosen };
}

export function SettingsNodeList({ description, nodeList, selectedId, onSelect }: {
  description: string;
  nodeList: readonly OrchestratorNode[];
  selectedId: string | null;
  onSelect(nodeId: string): void;
}) {
  const { t } = useTranslation();
  return <>
    <SettingsListHeader title={t("admin.config.nodes")} description={description} actions={null} />
    <SettingsListSection isEmpty={nodeList.length === 0} emptyText={t("admin.config.noNodes")}>
      {nodeList.map((node) => <SettingsListRow
        key={node.nodeId}
        title={node.nodeId}
        meta={node.status === "connected" ? t("admin.config.connected") : t("admin.config.disconnected")}
        selected={node.nodeId === selectedId}
        onSelect={() => onSelect(node.nodeId)}
      />)}
    </SettingsListSection>
  </>;
}

import type { OrchestratorNode } from "../store/orchestrator-store";
import { NodeGitPanel } from "./git-repos/NodeGitPanel";
import { SettingsDetailHeader, SettingsListDetailFrame } from "./config/SettingsListDetail";
import { SettingsNodeList, useSettingsNodeSelection } from "./config/SettingsNodeList";

/**
 * 「Git과 저장소」 설정 탭. 노드 목록에서 노드를 고르면 상세에 그 노드 워커 계정의 Git 사용자,
 * SSH 키, 프로젝트 저장소가 놓인다. 코딩 에이전트 연결 탭과 같은 노드 목록과 기본 선택을 쓴다.
 */
export function GitReposTab({ request, sampleNodes }: {
  request?: typeof fetch;
  sampleNodes?: Map<string, OrchestratorNode>;
}) {
  const { nodeList, selectedId, selected, select } = useSettingsNodeSelection(sampleNodes);
  return <SettingsListDetailFrame testId="git-repos-tab" list={<SettingsNodeList description="Git을 설정할 노드" nodeList={nodeList} selectedId={selectedId} onSelect={select} />}>
    {selected ? <>
      <SettingsDetailHeader title={selected.nodeId} />
      <NodeGitPanel key={selected.nodeId} node={selected} request={request ?? fetch} />
    </> : null}
  </SettingsListDetailFrame>;
}

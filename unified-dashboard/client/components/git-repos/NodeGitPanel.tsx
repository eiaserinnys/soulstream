import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NodeGitSetupSnapshot } from "../../../../packages/wire-schema/generated/typescript/index";
import { FrameLoading } from "@seosoyoung/soul-ui";
import { getNodeGit } from "../../lib/node-git-api";
import type { OrchestratorNode } from "../../store/orchestrator-store";
import { V3ErrorNotice } from "../../v3/V3ErrorNotice";
import { SettingsAlert } from "../config/SettingsListDetail";
import { GitIdentitySection } from "./GitIdentitySection";
import { GitRepositoriesSection } from "./GitRepositoriesSection";
import { GitSshSection } from "./GitSshSection";

export type NodeGitSectionProps = {
  nodeId: string;
  request: typeof fetch;
  snapshot: NodeGitSetupSnapshot;
  onSnapshot(next: NodeGitSetupSnapshot): void;
};

const nodeGitKey = (nodeId: string) => ["node-git", nodeId] as const;

/** 끊긴 노드와 이 기능을 모르는 옛 노드에는 요청을 보내지 않고 안내만 보인다. */
export function NodeGitPanel({ node, request }: { node: OrchestratorNode; request: typeof fetch }) {
  if (node.status !== "connected") {
    return <SettingsAlert>노드가 연결되어 있지 않습니다.</SettingsAlert>;
  }
  if (node.capabilities.node_git_setup_v1 !== true) {
    return <SettingsAlert>이 노드를 업데이트하면 쓸 수 있습니다.</SettingsAlert>;
  }
  return <LoadedNodeGit nodeId={node.nodeId} request={request} />;
}

function LoadedNodeGit({ nodeId, request }: { nodeId: string; request: typeof fetch }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: nodeGitKey(nodeId), queryFn: () => getNodeGit(request, nodeId), retry: false });
  if (query.data === undefined) {
    return query.isError
      ? <V3ErrorNotice message="Git 설정을 불러오지 못했습니다." detail={query.error.message} onRetry={() => { void query.refetch(); }} />
      : <FrameLoading inline label="불러오는 중…" />;
  }
  const props: NodeGitSectionProps = {
    nodeId,
    request,
    snapshot: query.data,
    onSnapshot: (next) => queryClient.setQueryData(nodeGitKey(nodeId), next),
  };
  return <div className="space-y-4">
    <GitIdentitySection {...props} />
    <GitSshSection {...props} />
    <GitRepositoriesSection {...props} onReload={() => { void queryClient.invalidateQueries({ queryKey: nodeGitKey(nodeId) }); }} />
  </div>;
}

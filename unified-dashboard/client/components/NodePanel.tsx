/**
 * NodePanel - 좌측 하단 노드 목록 패널 (unified-dashboard)
 *
 * V3 설정의 노드 상태와 공급자 중립 사용량 패널을 표시한다.
 * 노드 헤더 클릭 시 NodeProvidersPanel이 확장되고, 그 아래에 노드의 cogito 상태가 붙는다.
 * 스크롤은 바깥 설정 상세 영역(.config-detail) 하나가 맡는다.
 */

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn, nodeIdToHue, useTheme, DashboardIconCap, findUsageSummaryNode } from "@seosoyoung/soul-ui";
import { RotateCcw } from "lucide-react";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { fetchUsageSummary, refreshUsageSummary } from "../lib/usage-summary";
import { useCogitoHealth } from "../hooks/useCogitoHealth";
import { CogitoNodeHealthNote, CogitoNodeHealthRow } from "./CogitoHealthPanel";
import { clockLabel } from "./CogitoNodeHealthClock";
import { NodeProvidersPanel } from "./NodeProvidersPanel";
import "./claude-accounts/claude-account-pool.css";

export function NodePanel({ request, sampleNodes }: { request?: typeof fetch; sampleNodes?: ReturnType<typeof useOrchestratorStore.getState>["nodes"] } = {}) {
  const storedNodes = useOrchestratorStore((s) => s.nodes);
  const nodes = sampleNodes ?? storedNodes;
  const [theme] = useTheme();
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const [refreshingNodeId, setRefreshingNodeId] = useState<string | null>(null);
  const [refreshFailedNodeId, setRefreshFailedNodeId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const nodeList = useMemo(() => Array.from(nodes.values()), [nodes]);

  const summaryQuery = useQuery({
    queryKey: ["usage-summary"],
    queryFn: () => fetchUsageSummary(request ?? fetch),
    enabled: expandedNodeId !== null,
  });
  const summary = summaryQuery.data ?? null;

  // cogito는 한 번만 받아 nodeId로 묶는다. 노드를 펼칠 때마다 따로 받지 않는다.
  const cogito = useCogitoHealth(request);
  const cogitoByNode = useMemo(
    () => new Map((cogito.summary?.nodes ?? []).map((node) => [node.nodeId, node])),
    [cogito.summary],
  );

  async function handleRefresh(nodeId: string) {
    setRefreshingNodeId(nodeId);
    setRefreshFailedNodeId(null);
    cogito.refresh();
    try {
      const snapshot = await refreshUsageSummary(request ?? fetch);
      queryClient.setQueryData(["usage-summary"], snapshot);
      await queryClient.refetchQueries(
        { queryKey: ["claude-auth-accounts", nodeId] },
        { throwOnError: true },
      );
    } catch {
      setRefreshFailedNodeId(nodeId);
    } finally {
      setRefreshingNodeId(null);
    }
  }

  return (
    <div data-testid="node-panel-body" className="space-y-2 p-2">
      {nodeList.length === 0 ? (
        <div
          data-testid="node-card-list"
          className="flex min-h-28 flex-col items-center justify-center rounded-[13px] border border-border bg-muted/10 text-sm text-muted-foreground/40"
        >
          No nodes
        </div>
      ) : (
        <div data-testid="node-card-list" className="space-y-2">
          {nodeList.map((node) => {
            const hue = nodeIdToHue(node.nodeId);
            const isDead = node.status === "disconnected";
            const isDark = theme === "dark";
            const isExpanded = expandedNodeId === node.nodeId;
            const summaryNode = isExpanded ? findUsageSummaryNode(summary, node.nodeId) : null;
            const updated = clockLabel(summaryNode?.fetchedAt ?? null);
            const staleSince = summaryNode?.stale ? clockLabel(summaryNode.staleSince) : null;
            const cogitoNode = cogitoByNode.get(node.nodeId);

            return (
              <div
                key={node.nodeId}
                data-testid="node-card"
                className={cn(
                  "overflow-hidden rounded-[13px] border border-border bg-muted/10",
                  isDead && "opacity-60",
                )}
              >
                {/* Node header row — 클릭 시 공급자 패널 토글 */}
                <div
                  className="flex items-center gap-2 px-3 py-2 select-none cursor-pointer hover:bg-muted/30"
                  onClick={() =>
                    setExpandedNodeId(isExpanded ? null : node.nodeId)
                  }
                >
                  <div
                    className="w-5 h-5 rounded flex items-center justify-center text-xs font-bold font-mono shrink-0"
                    style={{
                      background: `hsl(${hue}, 12%, ${isDark ? "28%" : "88%"})`,
                      color: `hsl(${hue}, ${isDark ? "18%, 72%" : "30%, 35%"})`,
                      border: `1px solid hsl(${hue}, 12%, ${isDark ? "35%" : "75%"})`,
                    }}
                  >
                    {node.nodeId[0]?.toUpperCase()}
                  </div>
                  {/* 이름은 자기 글자 폭을 먼저 지키고, 좁은 폭에서는 시각 글이 먼저 줄어든다. */}
                  <span className="text-sm font-medium text-foreground truncate flex-auto min-w-0">
                    {node.nodeId}
                  </span>
                  {isExpanded && staleSince ? (
                    // 좁은 폭에서는 배지가 이름 자리를 먹지 않도록 펼친 패널 안으로 내린다.
                    // `.c724-badge`의 display가 Tailwind hidden을 이기므로 숨김은 바깥 상자가 맡는다.
                    <span className="hidden shrink-0 sm:inline-flex">
                      <span className="c724-badge c724-badge-warn">수집 지연 · {staleSince}</span>
                    </span>
                  ) : isExpanded && updated ? (
                    // 좁은 폭에서는 이름이 먼저 남고 시각 글이 물러난다. 시각은 펼친 cogito 행이 그대로 보여 준다.
                    <span className="hidden min-w-0 shrink-[100] truncate text-xs text-muted-foreground sm:inline">{updated} 갱신</span>
                  ) : null}
                  {/* 실패 배지는 새로 고침 단추 왼쪽에 붙여, 나타날 때 단추가 밀리지 않게 한다. */}
                  {isExpanded && refreshFailedNodeId === node.nodeId ? (
                    <span className="c724-badge c724-badge-danger">갱신 실패</span>
                  ) : null}
                  {isExpanded ? (
                    <DashboardIconCap
                      size="small"
                      label="사용량 새로 고침"
                      className="shrink-0"
                      // 갱신 중에도 초점을 잃지 않도록 disabled 대신 aria-disabled를 쓰고,
                      // 다시 눌러도 handleRefresh가 중복 실행되지 않게 막는다.
                      aria-disabled={refreshingNodeId === node.nodeId}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (refreshingNodeId === node.nodeId) return;
                        void handleRefresh(node.nodeId);
                      }}
                    >
                      <RotateCcw className={cn("size-4", refreshingNodeId === node.nodeId && "animate-spin")} aria-hidden="true" />
                    </DashboardIconCap>
                  ) : null}
                  <div
                    className={cn(
                      "w-[7px] h-[7px] rounded-full shrink-0",
                      isDead
                        ? "bg-muted-foreground/30"
                        : "bg-success shadow-[0_0_6px_rgba(16,185,129,0.3)]",
                    )}
                  />
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {isExpanded ? "▲" : "▼"}
                  </span>
                </div>
                {/* 확장 패널 — 공급자 중립 사용량 아래에 그 노드의 cogito 상태 */}
                {isExpanded && <div className="border-t border-border px-3 py-3">
                  {staleSince ? (
                    <div className="mb-2 sm:hidden">
                      <span className="c724-badge c724-badge-warn">수집 지연 · {staleSince}</span>
                    </div>
                  ) : null}
                  <NodeProvidersPanel
                    request={request ?? fetch}
                    nodeId={node.nodeId}
                    node={summaryNode}
                    loading={summaryQuery.isPending}
                  />
                  {cogito.loading ? (
                    <CogitoNodeHealthNote state={{ kind: "loading" }} />
                  ) : cogito.error ? (
                    <CogitoNodeHealthNote state={{ kind: "error", message: cogito.error }} />
                  ) : cogitoNode ? (
                    <CogitoNodeHealthRow node={cogitoNode} embedded />
                  ) : null}
                </div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

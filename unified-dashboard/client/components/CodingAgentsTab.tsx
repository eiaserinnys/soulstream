import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findUsageSummaryNode, useAuth } from "@seosoyoung/soul-ui";
import type { OrchestratorNode } from "../store/orchestrator-store";
import { useUsageSummary } from "../hooks/useUsageSummary";
import { refreshUsageSummary } from "../lib/usage-summary";
import { AntigravityBackendRow } from "./AntigravityBackendRow";
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
 * 맨 위 한 줄은 설치 전체의 Antigravity 스위치다. 꺼져 있으면 서버가 Antigravity를 없는 것처럼 다룬다.
 * 켜면 서버가 모아 둔 사용량에는 Antigravity가 아직 미설정으로 남아 있어, 먼저 새로 모은 뒤 다시 읽는다.
 * 그 동안은 Antigravity 줄을 숨겨 「미설정」과 「연결」이 잠깐 보이지 않게 한다.
 */
type AgySync = "idle" | "refreshing" | "retrying";

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
  const [agySync, setAgySync] = useState<AgySync>("idle");
  const latestEvaluatedAtMs = useRef(0);
  latestEvaluatedAtMs.current = usage.evaluatedAtMs;
  const evaluatedBeforeRetry = useRef(0);
  useEffect(() => {
    if (agySync === "retrying" && !usage.loading && usage.evaluatedAtMs !== evaluatedBeforeRetry.current) setAgySync("idle");
  }, [agySync, usage.loading, usage.evaluatedAtMs]);
  const { retry } = usage;
  const onAgySaved = useCallback(async (enabled: boolean) => {
    if (!enabled) { retry(); return; }
    setAgySync("refreshing");
    try { await refreshUsageSummary(send); } catch { /* 새로 모으지 못하면 다시 읽기만 한다 */ }
    evaluatedBeforeRetry.current = latestEvaluatedAtMs.current;
    setAgySync("retrying");
    retry();
  }, [retry, send]);
  const foundNode = findUsageSummaryNode(usage.summary, selectedId);
  const summaryNode = useMemo(() => agySync === "idle" || foundNode === null
    ? foundNode
    : { ...foundNode, providers: { ...foundNode.providers, antigravity: null } }, [agySync, foundNode]);

  return <div className="space-y-4">
  <AntigravityBackendRow request={send} onSaved={(enabled) => void onAgySaved(enabled)} />
  <SettingsListDetailFrame testId="coding-agents-tab" list={<SettingsNodeList description="코딩 에이전트를 연결할 노드" nodeList={nodeList} selectedId={selectedId} onSelect={select} />}>
    {selected ? <>
      <SettingsDetailHeader title={selected.nodeId} />
      {selected.status === "connected"
        ? <NodeProvidersPanel nodeId={selected.nodeId} request={send} node={summaryNode} loading={usage.loading && summaryNode === null} onUsageChanged={usage.retry} />
        : <SettingsAlert><span data-v3-selectable-content="true">노드가 연결되어 있지 않아 로그인할 수 없습니다.</span></SettingsAlert>}
    </> : null}
  </SettingsListDetailFrame>
  </div>;
}

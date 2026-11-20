import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ClaudeAccountList } from '../../../../packages/soul-ui/src/lib/usage-summary';
import { createApiClient } from '../../api/client';
import { useTokens, type DesignTokens } from '../../theme';
import { FrameLoading } from '../FrameLoading';
import {
  hasCentralPool,
  NodeProviderSections,
  type CentralCapableApi,
  type NodeProviderSectionsApi,
} from './NodeProviderSections';
import { ClaudeAccountPoolSection } from './ClaudeAccountPoolSection';
import { SettingsOptionRow } from './SettingsOptionRow';
import { GlassButton } from '../GlassSurface';
import { SettingsDivider, SettingsSection } from './SettingsSection';
import { makeClaudePoolStyles } from './claudeAccountPoolStyles';

type BackendNode = { nodeId: string };

export function AIBackendSettingsSection({
  flattened,
  serverUrl,
  mode,
  currentNodeId,
  nodes,
  loadingNodes,
  apiClient,
  error, onRetry,
}: {
  flattened: boolean;
  serverUrl: string;
  mode: 'single' | 'orchestrator' | null;
  currentNodeId: string;
  nodes: BackendNode[];
  loadingNodes: boolean;
  apiClient?: NodeProviderSectionsApi;
  error?: string | null; onRetry?: () => void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const visibleNodes =
    mode === 'orchestrator'
      ? nodes
      : mode === 'single' && currentNodeId
        ? [{ nodeId: currentNodeId }]
        : [];

  const [selectedNode, setSelectedNode] = useState(currentNodeId);
  useEffect(() => { setSelectedNode(currentNodeId || visibleNodes[0]?.nodeId || ''); }, [serverUrl, currentNodeId]);
  const selected = visibleNodes.find(node => node.nodeId === selectedNode) ?? visibleNodes[0];
  const resolvedApi = useMemo(
    () => apiClient ?? (serverUrl ? createApiClient(serverUrl) : null),
    [apiClient, serverUrl],
  );
  // 중앙 풀은 오케스트레이터에만 있다. single 모드와 중앙 API가 없는 대역에서는 그리지 않는다.
  const centralApi = resolvedApi && hasCentralPool(resolvedApi) ? resolvedApi : null;
  // 중앙 계정이 바뀌면 고른 노드의 Claude 목록과 사용량 요약을 다시 읽게 하는 신호.
  const [centralRevision, setCentralRevision] = useState(0);
  const handleCentralChange = useCallback(() => setCentralRevision(value => value + 1), []);
  return (
    <View testID="settings-section-backends">
    {mode === 'orchestrator' && centralApi
      ? <CentralPoolZone flattened={flattened} api={centralApi} onCentralChange={handleCentralChange} />
      : null}
    <SettingsSection id="backend-scope" title="AI 연결과 사용량" flattened={flattened}>
      {error ? <View style={styles.state}><Text accessibilityRole="alert" style={styles.notice}>{error}</Text><GlassButton onPress={() => onRetry?.()}><Text style={styles.notice}>다시 시도</Text></GlassButton></View> : !serverUrl || mode === null ? (
        <View style={styles.state}>
          {!serverUrl ? (
            <Text style={styles.notice}>연결 설정을 저장하면 노드를 표시합니다.</Text>
          ) : (
            <FrameLoading testID="ai-backend-mode-loading" inline />
          )}
        </View>
      ) : loadingNodes ? (
        <View style={styles.state}>
          <FrameLoading testID="ai-backend-nodes-loading" inline />
        </View>
      ) : visibleNodes.length === 0 ? (
        <View style={styles.state}>
          <Text style={styles.notice}>연결된 노드가 없습니다.</Text>
        </View>
      ) : (
        <View style={{ padding: t.cardLayout.padding, gap: t.spacing.md }}>
          <SettingsOptionRow label="조회 노드" selected={selected?.nodeId ?? ''} options={visibleNodes.map(node => ({ id: node.nodeId, label: node.nodeId }))} onSelect={setSelectedNode} emptyLabel="연결된 노드 없음"/>
        </View>
      )}
    </SettingsSection>
    {!error && !loadingNodes && selected ? <NodeProviderSections key={`${serverUrl}:${selected.nodeId}`} nodeId={selected.nodeId} serverUrl={serverUrl} apiClient={apiClient} centralRevision={centralRevision}/> : null}
    </View>
  );
}

/**
 * 「AI 연결과 사용량」의 조회 노드 고르기 위에 서는 중앙 풀 구역.
 *
 * 목록은 이 구역이 직접 읽고, 읽은 뒤에는 노드 목록과 같은 ClaudeAccountPoolSection이
 * 대상만 중앙으로 바꿔 그린다. 목록 로딩과 실패는 이 화면 다른 구역과 같은 꼴이다.
 */
function CentralPoolZone({ flattened, api, onCentralChange }: { flattened: boolean; api: CentralCapableApi; onCentralChange(): void }) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const poolStyles = useMemo(() => makeClaudePoolStyles(t), [t]);
  const mountedRef = useRef(true);
  const [list, setList] = useState<ClaudeAccountList | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const next = await api.getCentralClaudeAuthAccounts();
      if (mountedRef.current) setList(next);
    } catch {
      if (mountedRef.current) setFailed(true);
    }
  }, [api]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => { mountedRef.current = false; };
  }, [load, reloadKey]);

  return <SettingsSection id="central-pool" title="중앙 풀" flattened={flattened}>
    {list
      ? <ClaudeAccountPoolSection central api={api} title="중앙 풀" initialList={list}
        onListChange={setList} onCentralChange={onCentralChange} />
      : <>
        {/* 실제 설정 화면은 SettingsWorkspaceContext를 넘겨 SettingsSection 제목을 숨긴다.
            그래서 목록이 오기 전에도 풀 머리와 같은 꼴로 「중앙 풀」을 직접 그린다. */}
        <View style={poolStyles.poolTopBar} testID="central-pool-title">
          <View style={poolStyles.poolTitleRow}>
            <Text style={poolStyles.poolTitle}>중앙 풀</Text>
          </View>
        </View>
        <SettingsDivider />
        {failed
          ? <View style={styles.state}>
            <Text accessibilityRole="alert" style={styles.notice}>계정 목록을 갱신하지 못했습니다.</Text>
            <GlassButton accessibilityLabel="다시 시도" onPress={() => { setList(null); setReloadKey(value => value + 1); }}>
              <Text style={styles.notice}>다시 시도</Text>
            </GlassButton>
          </View>
          : <FrameLoading testID="central-pool-loading" inline />}
      </>}
  </SettingsSection>;
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    state: {
      minHeight: t.foundation.minHeight.row,
      alignItems: 'center',
      justifyContent: 'center',
      padding: t.cardLayout.padding,
    },
    notice: {
      ...t.foundation.typography.body,
      color: t.colors.textMuted,
      textAlign: 'center',
    },
  });
}

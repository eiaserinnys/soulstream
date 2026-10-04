import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTokens, type DesignTokens } from '../../theme';
import { NodeProviderSections } from './NodeProviderSections';
import { SettingsOptionRow } from './SettingsOptionRow';
import { GlassButton } from '../GlassSurface';
import { SettingsSection } from './SettingsSection';

type BackendNode = { nodeId: string };

export function AIBackendSettingsSection({
  flattened,
  serverUrl,
  mode,
  currentNodeId,
  nodes,
  loadingNodes,
  error, onRetry,
}: {
  flattened: boolean;
  serverUrl: string;
  mode: 'single' | 'orchestrator' | null;
  currentNodeId: string;
  nodes: BackendNode[];
  loadingNodes: boolean;
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
  return (
    <View testID="settings-section-backends">
    <SettingsSection id="backend-scope" title="AI 연결과 사용량" flattened={flattened}>
      {error ? <View style={styles.state}><Text accessibilityRole="alert" style={styles.notice}>{error}</Text><GlassButton onPress={() => onRetry?.()}><Text style={styles.notice}>다시 시도</Text></GlassButton></View> : !serverUrl || mode === null ? (
        <View style={styles.state}>
          {!serverUrl ? (
            <Text style={styles.notice}>연결 설정을 저장하면 노드를 표시합니다.</Text>
          ) : (
            <ActivityIndicator size="small" color={t.colors.accent} />
          )}
        </View>
      ) : loadingNodes ? (
        <View style={styles.state}>
          <ActivityIndicator size="small" color={t.colors.accent} />
        </View>
      ) : visibleNodes.length === 0 ? (
        <View style={styles.state}>
          <Text style={styles.notice}>연결된 노드가 없습니다.</Text>
        </View>
      ) : (
        <View style={{ padding: t.cardLayout.padding, gap: t.spacing.md }}>
          <Text style={styles.notice}>선택한 노드의 계정과 사용량을 조회합니다. 실행 노드는 바뀌지 않습니다.</Text>
          <SettingsOptionRow label="조회 노드" selected={selected?.nodeId ?? ''} options={visibleNodes.map(node => ({ id: node.nodeId, label: node.nodeId }))} onSelect={setSelectedNode} emptyLabel="연결된 노드 없음"/>
        </View>
      )}
    </SettingsSection>
    {!error && !loadingNodes && selected ? <NodeProviderSections key={`${serverUrl}:${selected.nodeId}`} nodeId={selected.nodeId} serverUrl={serverUrl}/> : null}
    </View>
  );
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

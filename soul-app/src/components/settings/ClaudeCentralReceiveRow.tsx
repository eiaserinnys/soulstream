import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { ClaudeCentralSettings } from '../../../../packages/soul-ui/src/lib/usage-summary';
import type { ApiClient } from '../../api/client';
import { useTokens } from '../../theme';
import { SettingsAction, SettingsToggleRow, useSettingsFormStyles } from './SettingsFormParts';
import { makeClaudePoolStyles } from './claudeAccountPoolStyles';

export type ClaudeCentralSettingsApi = Pick<
  ApiClient,
  'getClaudeCentralSettings' | 'putClaudeCentralReceive'
>;

type Props = {
  nodeId: string;
  api: ClaudeCentralSettingsApi;
  onSaved?(): void;
};

/**
 * 노드의 클로드 계정 목록 맨 위에 서는 「중앙 풀 받기」 한 줄.
 *
 * 값은 중앙 설정의 그 노드 `receive`다. 저장하는 동안에는 바뀐 쪽으로 보이되 눌리지 않고,
 * 실패하면 원래 값으로 돌아간 스위치가 제자리에 남는다. 다시 시도는 그 스위치를 다시 누르는
 * 것이고, 오류 글은 이름 아래 줄 안에 서며 다음 저장을 시작할 때 지운다. 설정을 못 읽어 값을 알 수
 * 없을 때만 「중앙 풀 받기」 이름은 남긴 채 스위치 자리가 「다시 시도」로 바뀐다.
 */
export function ClaudeCentralReceiveRow({ nodeId, api, onSaved }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeClaudePoolStyles(t), [t]);
  const formStyles = useSettingsFormStyles();
  const mountedRef = useRef(true);
  const [settings, setSettings] = useState<ClaudeCentralSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState<boolean | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.getClaudeCentralSettings();
      if (mountedRef.current) {
        setSettings(next);
        setLoadFailed(false);
      }
    } catch {
      if (mountedRef.current) setLoadFailed(true);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => { mountedRef.current = false; };
  }, [load]);

  const effective = settings?.effective.find(entry => entry.node_id === nodeId)?.receive;
  const current = saving ?? effective ?? settings?.default_receive ?? false;
  const busy = loading || saving !== null || loadFailed;

  async function save(value: boolean) {
    if (busy) return;
    setSaving(value);
    setSaveFailed(false);
    try {
      const next = await api.putClaudeCentralReceive(nodeId, value);
      if (!mountedRef.current) return;
      setSettings(next);
      onSaved?.();
    } catch {
      if (mountedRef.current) setSaveFailed(true);
    } finally {
      if (mountedRef.current) setSaving(null);
    }
  }

  // 값을 모르는 설정 읽기 실패에만 스위치 자리를 「다시 시도」로 바꾼다. 이름은 그대로 남는다.
  if (loadFailed) {
    return <View testID="claude-central-receive" style={styles.centralReceiveRow}>
      <View style={formStyles.listRow}>
        <View style={formStyles.grow}>
          <Text style={formStyles.body}>중앙 풀 받기</Text>
          <Text accessibilityRole="alert" style={styles.errorText}>받기 설정을 불러오지 못했습니다.</Text>
        </View>
        <SettingsAction label="다시 시도" testID="claude-central-receive-retry" disabled={loading} onPress={() => void load()} />
      </View>
    </View>;
  }

  return <View testID="claude-central-receive" style={styles.centralReceiveRow}>
    <SettingsToggleRow
      label="중앙 풀 받기"
      value={current}
      disabled={busy}
      error={saveFailed ? '계정 설정을 저장하지 못했습니다. 다시 시도해 주세요.' : undefined}
      testID="claude-central-receive-switch"
      onValueChange={value => { if (!busy) void save(value); }}
    />
  </View>;
}

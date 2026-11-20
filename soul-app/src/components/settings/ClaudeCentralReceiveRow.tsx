import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { ClaudeCentralSettings } from '../../../../packages/soul-ui/src/lib/usage-summary';
import type { ApiClient } from '../../api/client';
import { useTokens } from '../../theme';
import { SettingsAction, SettingsToggleRow } from './SettingsFormParts';
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
 * 실패하면 원래 값으로 돌아가 같은 자리에서 다시 시도할 수 있다. 설정을 못 읽으면
 * 그 줄이 실패 안내와 다시 시도로 바뀐다.
 */
export function ClaudeCentralReceiveRow({ nodeId, api, onSaved }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeClaudePoolStyles(t), [t]);
  const mountedRef = useRef(true);
  const [settings, setSettings] = useState<ClaudeCentralSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState<boolean | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [retryValue, setRetryValue] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const next = await api.getClaudeCentralSettings();
      if (mountedRef.current) setSettings(next);
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
    setRetryValue(null);
    try {
      const next = await api.putClaudeCentralReceive(nodeId, value);
      if (!mountedRef.current) return;
      setSettings(next);
      onSaved?.();
    } catch {
      if (mountedRef.current) {
        setSaveFailed(true);
        setRetryValue(value);
      }
    } finally {
      if (mountedRef.current) setSaving(null);
    }
  }

  // 설정을 못 읽으면 스위치를 그리지 않고, 그 줄이 실패 안내와 다시 시도로 바뀐다.
  if (loadFailed) {
    return <View testID="claude-central-receive" style={styles.centralReceiveRow}>
      <View style={styles.confirmRow}>
        <Text accessibilityRole="alert" style={[styles.confirmPrompt, styles.errorText]}>
          계정 목록을 갱신하지 못했습니다.
        </Text>
        <SettingsAction label="다시 시도" testID="claude-central-receive-retry" onPress={() => void load()} />
      </View>
    </View>;
  }

  return <View testID="claude-central-receive" style={styles.centralReceiveRow}>
    <SettingsToggleRow
      label="중앙 풀 받기"
      value={current}
      disabled={busy}
      testID="claude-central-receive-switch"
      onValueChange={value => { if (!busy) void save(value); }}
    />
    {saveFailed ? <View style={styles.confirmRow}>
      <Text accessibilityRole="alert" style={[styles.confirmPrompt, styles.errorText]}>
        계정 설정을 저장하지 못했습니다. 다시 시도해 주세요.
      </Text>
      <SettingsAction
        label="다시 시도"
        testID="claude-central-receive-retry"
        onPress={() => { if (retryValue !== null) void save(retryValue); }}
      />
    </View> : null}
  </View>;
}

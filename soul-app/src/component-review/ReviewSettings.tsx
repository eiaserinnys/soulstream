import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useTokens } from '../theme';
import { useSettingsStore, type ServerType } from '../store/settingsStore';
import { usePlannerStore } from '../store/plannerStore';
import { GlassButton } from '../components/GlassSurface';
import { FolderSelectionSheet } from '../components/planner/FolderSelectionSheet';
import { ExecutionSelectionSheet } from '../components/planner/ExecutionSelectionSheet';
import { DisplaySettingsSection } from '../components/settings/DisplaySettingsSection';
import { ConnectionSettingsSection } from '../components/settings/ConnectionSettingsSection';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { createReviewApi, fixtureOptions, type FixtureState } from './fixtures';
import { ReviewSection } from './ReviewSection';

export function ReviewSettings() {
  const t = useTokens();
  const appearance = useSettingsStore((s) => s.appearance);
  const wallpaper = useSettingsStore((s) => s.wallpaper);
  const [state, setState] = useState<FixtureState>('normal');
  const api = useMemo(() => createReviewApi(state), [state]);
  const [modal, setModal] = useState<'folder' | 'agent' | null>(null);
  const [selected, setSelected] = useState('');
  const [url, setUrl] = useState('https://public.example');
  const [serverType, setServerType] = useState<ServerType>('soul-server');
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const labelStyle = { ...t.foundation.typography.body, color: t.colors.textPrimary };
  return <>
    <ReviewSection title="폴더·에이전트 선택">
      <SettingsSegmentedControl<FixtureState> id="review-selector-state" value={state} onChange={(value) => {
        usePlannerStore.setState({ starred: { items: [], nextCursor: null }, loading: {}, error: {} });
        setState(value);
      }} options={fixtureOptions} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm }}>
        <GlassButton accessibilityLabel="폴더 선택 열기" onPress={() => setModal('folder')}><Text style={labelStyle}>폴더 선택</Text></GlassButton>
        <GlassButton accessibilityLabel="에이전트 선택 열기" onPress={() => setModal('agent')}><Text style={labelStyle}>에이전트 선택</Text></GlassButton>
      </View>
      {selected ? <Text testID="review-selector-result" style={labelStyle}>선택: {selected}</Text> : null}
      {modal === 'folder' ? <FolderSelectionSheet api={api} onClose={() => setModal(null)}
        onSelect={(id) => setSelected(id)} /> : null}
      {modal === 'agent' ? <ExecutionSelectionSheet api={api}
        value={{ folderId: 'public-project', nodeId: 'public-node', agentId: 'public-agent', modelPreset: 'public-model' }}
        onClose={() => setModal(null)} onSave={(value) => setSelected([value.agentId, value.nodeId, value.modelPreset].join(' · '))} /> : null}
    </ReviewSection>
    <ConnectionSettingsSection flattened={false} url={url} serverType={serverType}
      testing={testing} result={result} onUrlChange={setUrl} onServerTypeChange={setServerType}
      onTest={() => {
        setTesting(true);
        setTimeout(() => {
          setTesting(false);
          setResult({ ok: state !== 'error', msg: state === 'error' ? '공개 예시: 연결 확인 실패' : '공개 예시: 연결 확인 성공' });
        }, 600);
      }}
      onSave={() => setResult({ ok: true, msg: '공개 예시: 이 화면에서만 설정을 저장했습니다.' })} />
    <DisplaySettingsSection flattened={false} appearance={appearance} wallpaper={wallpaper}
      wallpaperPreviewSource={require('../../assets/icon.png')} savingBackground={false}
      onAppearanceChange={(value) => useSettingsStore.getState().setAppearance(value)}
      onWallpaperModeChange={(value) => useSettingsStore.getState().setWallpaperMode(value)}
      onPickBackground={() => setSelected('공개 예시 배경 이미지')}
      onResetBackground={() => useSettingsStore.getState().setWallpaperMode('bokeh')} />
  </>;
}

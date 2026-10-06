import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { safeErrorDetail } from '../../../packages/soul-ui/src/lib/safe-error-detail';
import * as ImagePicker from 'expo-image-picker';
import { createApiClient } from '../api/client';
import { AIBackendSettingsSection } from '../components/settings/AIBackendSettingsSection';
import { ConnectionSettingsSection } from '../components/settings/ConnectionSettingsSection';
import { DiagnosticsSettingsSection } from '../components/settings/DiagnosticsSettingsSection';
import { DisplaySettingsSection } from '../components/settings/DisplaySettingsSection';
import { OwnedAgentsSettingsSection } from '../components/settings/OwnedAgentsSettingsSection';
import { SessionReviewPolicySettingsSection } from '../components/settings/SessionReviewPolicySettingsSection';
import { RecurringJobsSettingsSection } from '../components/settings/RecurringJobsSettingsSection';
import { PersistentSessionsSettingsSection } from '../components/settings/PersistentSessionsSettingsSection';
import type { SettingsCategory } from '../components/settings/settingsCategories';
import { useDashboardAdminStatus } from '../components/settings/useDashboardAdminStatus';
import { resolveBackgroundImageSource } from '../lib/wallpaper-source';
import { useAuthStore } from '../store/authStore';
import {
  useSettingsStore,
  type Appearance,
  type ServerType,
  type WallpaperMode,
  type WallpaperSettings,
} from '../store/settingsStore';
import { useTokens } from '../theme';
import { useSettingsWorkspace, useSettingsSaveScope } from '../components/settings/SettingsWorkspaceContext';
import { makeSettingsStyles } from './SettingsScreen.styles';
import { useDisplayPreferenceActions } from '../components/settings/useDisplayPreferenceActions';

type NodeInfo = Awaited<
  ReturnType<ReturnType<typeof createApiClient>['listNodes']>
>['nodes'][number];

interface Props {
  extraBottomPadding?: number;
  flattened?: boolean;
  category?: SettingsCategory;
  showAdmin?: boolean;
  onOpenRecurringJobs?: () => void;
  connectionOnly?: boolean;
}

export function SettingsContent({
  extraBottomPadding = 0,
  flattened = false,
  category,
  showAdmin,
  onOpenRecurringJobs,
  connectionOnly = false,
}: Props = {}) {
  const t = useTokens();
  const styles = useMemo(() => makeSettingsStyles(t), [t]);
  const {
    serverUrl,
    serverType,
    setSettings,
    nodeId,
    setNodeId,
    appearance,
    wallpaper,
    setWallpaper,
    setWallpaperMode,
    applyUserPreferences,
  } = useSettingsStore();
  const jwt = useAuthStore((state) => state.jwt);
  const detectedAdmin = useDashboardAdminStatus(showAdmin === undefined);
  const canManageReviewPolicy = showAdmin ?? detectedAdmin;
  const [urlInput, setUrlInput] = useState(serverUrl);
  const [typeInput, setTypeInput] = useState<ServerType>(serverType);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [mode, setMode] = useState<'single' | 'orchestrator' | null>(null);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [loadingNodes, setLoadingNodes] = useState(false);
  const workspace = useSettingsWorkspace();
  const [visited, setVisited] = useState<SettingsCategory[]>([category ?? 'display']);
  useEffect(() => { if (category) setVisited(current => current.includes(category) ? current : [...current, category]); }, [category]);
  const testRevision = useRef(0);
  const { preferencesRevision, identity, backgroundStatus, setBackgroundStatus, savePreferences, handleAppearanceChange } = useDisplayPreferenceActions();
  const [connectionSaved, setConnectionSaved] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [backendReload, setBackendReload] = useState(0);
  const backgroundPending = useRef(false);
  const backgroundRequest = useRef(0);
  const [savingBackground, setSavingBackground] = useState(false);

  useEffect(() => {
    if (!serverUrl) return;
    let active = true;
    setMode(null); setNodes([]); setBackendError(null); setLoadingNodes(true);
    const api = createApiClient(serverUrl);
    void (async () => {
      try {
        const config = await api.getConfig();
        const result = config.mode === 'orchestrator' ? await api.listNodes() : { nodes: [] };
        if (!active) return;
        setMode(config.mode);
        if (config.nodeId) setNodeId(config.nodeId);
        setNodes(result.nodes);
      } catch { if (active) setBackendError('노드를 불러오지 못했습니다. 다시 시도해 주세요.'); }
      finally { if (active) setLoadingNodes(false); }
    })();
    return () => { active = false; };
  }, [serverUrl, jwt, setNodeId, backendReload]);

  useEffect(() => () => { ++testRevision.current; ++backgroundRequest.current; }, []);
  useEffect(() => { ++backgroundRequest.current; backgroundPending.current = false; setSavingBackground(false); }, [serverUrl, jwt]);
  useEffect(() => { ++testRevision.current; setTestResult(null); setTesting(false); }, [serverUrl, jwt]);

  async function handleTest() {
    const url = urlInput.trim();
    if (!url) return;
    const revision = ++testRevision.current;
    setTesting(true);
    setTestResult(null);
    try {
      // 설정 중 입력한 URL은 현재 서버와 다를 수 있으므로 공개 연결 확인은 익명으로 한다.
      const config = await createApiClient(url, { authToken: null }).getConfig();
      if (revision !== testRevision.current) return;
      setTestResult({ ok: true, msg: `연결됨: ${config.mode} 모드` });
    } catch (error: any) {
      if (revision !== testRevision.current) return;
      setTestResult({
        ok: false,
        msg: `연결 실패: ${safeErrorDetail(error?.message ?? String(error))}`,
      });
    } finally {
      if (revision === testRevision.current) setTesting(false);
    }
  }

  function handleSave() {
    const url = urlInput.trim();
    if (!url) return;
    const apply = () => {
      if (url !== serverUrl) useAuthStore.getState().clear();
      setSettings(url, typeInput); setConnectionSaved(true);
      ++testRevision.current; setTesting(false); setTestResult(null);
    };
    if (url !== serverUrl && workspace) workspace.changeConnection(apply); else apply();
  }

  async function handleWallpaperModeChange(next: WallpaperMode) {
    if (backgroundPending.current) return;
    const nextWallpaper =
      next === 'photo'
        ? { ...wallpaper, mode: 'photo' as const }
        : { mode: next };
    setWallpaperMode(next);
    await savePreferences(appearance, nextWallpaper, {
      clearBackground: next !== 'photo',
    });
  }

  async function handlePickBackground() {
    if (backgroundPending.current) return;
    const scope = identity.current;
    const revision = ++preferencesRevision.current;
    const pickerRequest = ++backgroundRequest.current;
    backgroundPending.current = true;
    setSavingBackground(true);
    try {
      const permission =
        await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('권한 필요', '사진 라이브러리 접근 권한을 허용해주세요.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.9,
      });
      if (result.canceled || result.assets.length === 0) return;
      const asset = result.assets[0];
      const nextWallpaper = {
        mode: 'photo' as const,
        customImage: asset.uri,
      };
      if (revision !== preferencesRevision.current || identity.current.serverUrl !== scope.serverUrl || identity.current.jwt !== scope.jwt) return;
      setWallpaper(nextWallpaper);
      setBackgroundStatus('이 기기에 사진을 적용했습니다.');
      if (!serverUrl || !useAuthStore.getState().jwt) return;

      const api = createApiClient(serverUrl);
      const uploaded = await api.uploadUserBackground({
        uri: asset.uri,
        name: asset.fileName ?? `wallpaper-${Date.now()}.jpg`,
        type: asset.mimeType ?? 'image/jpeg',
      });
      if (revision !== preferencesRevision.current || identity.current.serverUrl !== scope.serverUrl || identity.current.jwt !== scope.jwt) return;
      const saved = await api.putUserPreferences({
        appearance,
        wallpaper: uploaded.wallpaper,
      });
      if (revision !== preferencesRevision.current || identity.current.serverUrl !== scope.serverUrl || identity.current.jwt !== scope.jwt) return;
      applyUserPreferences(saved.preferences);
      setBackgroundStatus('이 기기와 서버에 사진을 적용했습니다.');
    } catch (error: any) {
      if (revision === preferencesRevision.current && identity.current.serverUrl === scope.serverUrl && identity.current.jwt === scope.jwt) Alert.alert('배경 저장 실패', safeErrorDetail(error?.message ?? String(error)));
    } finally {
      if (pickerRequest === backgroundRequest.current) { backgroundPending.current = false; setSavingBackground(false); }
    }
  }

  async function handleResetBackground() {
    if (backgroundPending.current) return;
    const nextWallpaper = { mode: 'bokeh' as const };
    setWallpaper(nextWallpaper);
    await savePreferences(appearance, nextWallpaper, {
      clearBackground: true,
    });
  }

  const wallpaperPreviewSource = resolveBackgroundImageSource(
    serverUrl,
    wallpaper.customImage,
    jwt,
  );
  const includes = (candidate: SettingsCategory) =>
    category === undefined || category === candidate;

  useSettingsSaveScope('connection', {
    dirty: urlInput.trim() !== serverUrl || typeInput !== serverType,
    canSave: Boolean(urlInput.trim()), saveLabel: '연결 저장', saveTestID: 'settings-save',
    save: handleSave,
    discard: () => { setUrlInput(serverUrl); setTypeInput(serverType); setTestResult(null); setConnectionSaved(false); ++testRevision.current; setTesting(false); },
  });
  const renderCategory = (id: SettingsCategory) => (!connectionOnly || id === 'connection') && visited.includes(id);
  const pageProps = (id: SettingsCategory) => ({
    testID: `settings-detail-${id}`,
    style: { flex: 1, minHeight: 0, display: includes(id) ? 'flex' as const : 'none' as const },
    accessibilityElementsHidden: !includes(id),
    importantForAccessibility: !includes(id) ? 'no-hide-descendants' as const : 'auto' as const,
    keyboardShouldPersistTaps: 'handled' as const,
    contentContainerStyle: [styles.container, { paddingBottom: t.spacing.xl + extraBottomPadding }],
  });
  return <View style={{ flex: 1, minHeight: 0 }}>
          {renderCategory('display') ? (
            <ScrollView {...pageProps('display')}>
            <DisplaySettingsSection
              flattened={flattened}
              appearance={appearance}
              wallpaper={wallpaper}
              wallpaperPreviewSource={wallpaperPreviewSource}
              savingBackground={savingBackground}
              status={backgroundStatus}
              onAppearanceChange={(value) =>
                void handleAppearanceChange(value)
              }
              onWallpaperModeChange={(value) =>
                void handleWallpaperModeChange(value)
              }
              onPickBackground={() => void handlePickBackground()}
              onResetBackground={() => void handleResetBackground()}
            />
            </ScrollView>
          ) : null}
          {renderCategory('owned-agents') ? (
            <ScrollView {...pageProps('owned-agents')}>
              <OwnedAgentsSettingsSection
                flattened={flattened}
                serverUrl={serverUrl}
                active={includes('owned-agents')}
              />
            </ScrollView>
          ) : null}
          {renderCategory('connection') ? (
            <ScrollView {...pageProps('connection')}>
            <ConnectionSettingsSection
              flattened={flattened}
              url={urlInput}
              serverType={typeInput}
              testing={testing}
              result={testResult}
              savedUrl={serverUrl}
              savedType={serverType}
              runtimeMode={mode}
              saved={connectionSaved}
              hideSave={Boolean(workspace)}
              onUrlChange={(value) => {
                ++testRevision.current; setTesting(false); setConnectionSaved(false);
                setUrlInput(value);
                setTestResult(null);
              }}
              onServerTypeChange={value => { setTypeInput(value); setConnectionSaved(false); ++testRevision.current; setTesting(false); setTestResult(null); }}
              onTest={() => void handleTest()}
              onSave={handleSave}
            />
            </ScrollView>
          ) : null}
          {renderCategory('backends') ? (
            <ScrollView {...pageProps('backends')}>
            <AIBackendSettingsSection
              flattened={flattened}
              serverUrl={serverUrl}
              mode={mode}
              currentNodeId={nodeId}
              nodes={nodes}
              loadingNodes={loadingNodes}
              error={backendError}
              onRetry={() => setBackendReload(value => value + 1)}
            />
            </ScrollView>
          ) : null}
          {renderCategory('recurring-jobs') ? (
            <View style={{ flex: 1, minHeight: 0, display: includes('recurring-jobs') ? 'flex' : 'none' }} accessibilityElementsHidden={!includes('recurring-jobs')} importantForAccessibility={!includes('recurring-jobs') ? 'no-hide-descendants' : 'auto'}>
            <RecurringJobsSettingsSection
              flattened={flattened}
              serverUrl={serverUrl}
              onOpenRecurringJobs={onOpenRecurringJobs}
            />
            </View>
          ) : null}
          {renderCategory('persistent') ? (
            <View style={{ flex: 1, minHeight: 0, display: includes('persistent') ? 'flex' : 'none' }} accessibilityElementsHidden={!includes('persistent')} importantForAccessibility={!includes('persistent') ? 'no-hide-descendants' : 'auto'}>
            <PersistentSessionsSettingsSection serverUrl={serverUrl} />
            </View>
          ) : null}
          {renderCategory('review-policy') && canManageReviewPolicy ? (
            <ScrollView {...pageProps('review-policy')}>
            <SessionReviewPolicySettingsSection
              flattened={flattened}
              serverUrl={serverUrl}
            />
            </ScrollView>
          ) : null}
          {renderCategory('diagnostics') ? (
            <ScrollView {...pageProps('diagnostics')}>
            <DiagnosticsSettingsSection flattened={flattened} />
            </ScrollView>
          ) : null}
  </View>;
}

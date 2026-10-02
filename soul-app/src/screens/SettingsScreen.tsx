import { usePersistentDraft } from '../hooks/usePersistentDraft';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Platform, ScrollView, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { createApiClient } from '../api/client';
import { AppKeyboardAvoidingView } from '../components/AppKeyboardAvoidingView';
import { AIBackendSettingsSection } from '../components/settings/AIBackendSettingsSection';
import { ConnectionSettingsSection } from '../components/settings/ConnectionSettingsSection';
import { DiagnosticsSettingsSection } from '../components/settings/DiagnosticsSettingsSection';
import { DisplaySettingsSection } from '../components/settings/DisplaySettingsSection';
import { SessionReviewPolicySettingsSection } from '../components/settings/SessionReviewPolicySettingsSection';
import { RecurringJobsSettingsSection } from '../components/settings/RecurringJobsSettingsSection';
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
import { makeSettingsStyles } from './SettingsScreen.styles';

type NodeInfo = Awaited<
  ReturnType<ReturnType<typeof createApiClient>['listNodes']>
>['nodes'][number];

interface Props {
  extraBottomPadding?: number;
  showTitle?: boolean;
  flattened?: boolean;
  category?: SettingsCategory;
  showAdmin?: boolean;
  onOpenRecurringJobs?: () => void;
}

export function SettingsScreen({
  extraBottomPadding = 0,
  showTitle = true,
  flattened = false,
  category,
  showAdmin,
  onOpenRecurringJobs,
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
    setAppearance,
    wallpaper,
    setWallpaper,
    setWallpaperMode,
    applyUserPreferences,
  } = useSettingsStore();
  const jwt = useAuthStore((state) => state.jwt);
  const detectedAdmin = useDashboardAdminStatus(showAdmin === undefined);
  const canManageReviewPolicy = showAdmin ?? detectedAdmin;
  const connectionDraft = usePersistentDraft('connection-settings', [], { url: serverUrl, type: serverType }, { deviceLocal: true });
  const { url: urlInput, type: typeInput } = connectionDraft.value;
  const setUrlInput = (url: string) => connectionDraft.setValue(current => ({ ...current, url }));
  const setTypeInput = (type: ServerType) => connectionDraft.setValue(current => ({ ...current, type }));
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [mode, setMode] = useState<'single' | 'orchestrator' | null>(null);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [loadingNodes, setLoadingNodes] = useState(false);
  const [savingBackground, setSavingBackground] = useState(false);

  useEffect(() => {
    if (!serverUrl) return;
    setMode(null);
    setNodes([]);
    const api = createApiClient(serverUrl);
    api
      .getConfig()
      .then((config) => {
        setMode(config.mode);
        if (config.nodeId) setNodeId(config.nodeId);
        if (config.mode === 'orchestrator') {
          setLoadingNodes(true);
          api
            .listNodes()
            .then((result) => setNodes(result.nodes))
            .catch(() => {})
            .finally(() => setLoadingNodes(false));
        }
      })
      .catch(() => {});
  }, [serverUrl, setNodeId]);

  async function handleTest() {
    const url = urlInput.trim();
    if (!url) return;
    setTesting(true);
    setTestResult(null);
    try {
      // 설정 중 입력한 URL은 현재 서버와 다를 수 있으므로 공개 연결 확인은 익명으로 한다.
      const config = await createApiClient(url, { authToken: null }).getConfig();
      setTestResult({ ok: true, msg: `연결됨: ${config.mode} 모드` });
    } catch (error: any) {
      setTestResult({
        ok: false,
        msg: `연결 실패: ${error?.message ?? '알 수 없는 오류'}`,
      });
    } finally {
      setTesting(false);
    }
  }

  function handleSave() {
    const url = urlInput.trim();
    if (!url) return;
    if (url !== serverUrl) useAuthStore.getState().clear();
    setSettings(url, typeInput);
    connectionDraft.clearIfMatches({ url: urlInput, type: typeInput });
  }

  async function savePreferences(
    nextAppearance: Appearance,
    nextWallpaper: WallpaperSettings,
    options: { clearBackground?: boolean } = {},
  ) {
    if (!serverUrl || !useAuthStore.getState().jwt) return;
    try {
      const response = await createApiClient(serverUrl).putUserPreferences(
        { appearance: nextAppearance, wallpaper: nextWallpaper },
        options,
      );
      applyUserPreferences(response.preferences);
    } catch {
      // Offline and single-node fallback: AsyncStorage remains the local source.
    }
  }

  async function handleAppearanceChange(next: Appearance) {
    setAppearance(next);
    await savePreferences(next, wallpaper);
  }

  async function handleWallpaperModeChange(next: WallpaperMode) {
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
    setWallpaper(nextWallpaper);
    if (!serverUrl || !useAuthStore.getState().jwt) return;

    setSavingBackground(true);
    try {
      const api = createApiClient(serverUrl);
      const uploaded = await api.uploadUserBackground({
        uri: asset.uri,
        name: asset.fileName ?? `wallpaper-${Date.now()}.jpg`,
        type: asset.mimeType ?? 'image/jpeg',
      });
      const saved = await api.putUserPreferences({
        appearance,
        wallpaper: uploaded.wallpaper,
      });
      applyUserPreferences(saved.preferences);
    } catch (error: any) {
      Alert.alert('배경 저장 실패', error?.message ?? '알 수 없는 오류');
    } finally {
      setSavingBackground(false);
    }
  }

  async function handleResetBackground() {
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

  return (
    <SafeAreaView
      testID="settings-safe-area"
      style={styles.flex}
      edges={flattened ? [] : ['left', 'right', 'bottom']}
    >
      <AppKeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          testID="phone-settings-body"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            styles.container,
            { paddingBottom: t.spacing.xl + extraBottomPadding },
          ]}
        >
          {showTitle ? <Text style={styles.title}>설정</Text> : null}
          {includes('display') ? (
            <DisplaySettingsSection
              flattened={flattened}
              appearance={appearance}
              wallpaper={wallpaper}
              wallpaperPreviewSource={wallpaperPreviewSource}
              savingBackground={savingBackground}
              onAppearanceChange={(value) =>
                void handleAppearanceChange(value)
              }
              onWallpaperModeChange={(value) =>
                void handleWallpaperModeChange(value)
              }
              onPickBackground={() => void handlePickBackground()}
              onResetBackground={() => void handleResetBackground()}
            />
          ) : null}
          {includes('connection') ? (
            <ConnectionSettingsSection ready={connectionDraft.ready}
              flattened={flattened}
              url={urlInput}
              serverType={typeInput}
              testing={testing}
              result={testResult}
              onUrlChange={(value) => {
                setUrlInput(value);
                setTestResult(null);
              }}
              onServerTypeChange={setTypeInput}
              onTest={() => void handleTest()}
              onSave={handleSave}
            />
          ) : null}
          {includes('backends') ? (
            <AIBackendSettingsSection
              flattened={flattened}
              serverUrl={serverUrl}
              mode={mode}
              currentNodeId={nodeId}
              nodes={nodes}
              loadingNodes={loadingNodes}
            />
          ) : null}
          {includes('recurring-jobs') ? (
            <RecurringJobsSettingsSection
              flattened={flattened}
              serverUrl={serverUrl}
              onOpenRecurringJobs={onOpenRecurringJobs}
            />
          ) : null}
          {canManageReviewPolicy && includes('review-policy') ? (
            <SessionReviewPolicySettingsSection
              flattened={flattened}
              serverUrl={serverUrl}
            />
          ) : null}
          {includes('diagnostics') ? (
            <DiagnosticsSettingsSection flattened={flattened} />
          ) : null}
        </ScrollView>
      </AppKeyboardAvoidingView>
    </SafeAreaView>
  );
}

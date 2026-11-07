import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as WebBrowser from 'expo-web-browser';
import type { AccountProfile } from '../../api/claudeAuthTypes';
import type { ApiClient } from '../../api/client';
import type { ClaudeAccountList } from '../../../../packages/soul-ui/src/lib/usage-summary';
import type { AppUsageSummaryProvider } from '../../api/usageEndpoints';
import { useTokens, type DesignTokens } from '../../theme';
import { useAuthStore } from '../../store/authStore';
import { DisclosureIcon } from '../DisclosureIcon';
import { GlassButton } from '../GlassSurface';
import {
  ClaudeAccountPoolSection,
  poolAvailabilityLabel,
  type ClaudeAccountPoolApi,
  type ClaudeAccountPoolSectionHandle,
} from './ClaudeAccountPoolSection';
import { makeClaudePoolStyles } from './claudeAccountPoolStyles';
import { ProviderQuotaGrid, ProviderQuotaSkeleton, providerQuotaCells } from './ProviderQuotaGrid';
import { SettingsDivider } from './SettingsSection';

export type ClaudeProviderApi = ClaudeAccountPoolApi & Pick<ApiClient,
  | 'getClaudeAuthStatus'
  | 'getClaudeProfile'
  | 'startClaudeAuth'
  | 'submitClaudeCode'
  | 'deleteClaudeToken'
>;

type Props = {
  nodeId: string;
  api: ClaudeProviderApi;
  summaryProvider: AppUsageSummaryProvider | null;
  loadingSummary: boolean;
  reloadKey: number;
  onTokenDeleted(): void;
};

function localClock(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function ProviderHeaderLoading({ testID, name }: { testID: string; name: string }) {
  const t = useTokens();
  const poolStyles = useMemo(() => makeClaudePoolStyles(t), [t]);
  return <View testID={testID} style={poolStyles.accountBlock}>
    <View style={poolStyles.accountHeaderRow}>
      <View style={poolStyles.accountIdentity}>
        <View style={[poolStyles.statusDot, { backgroundColor: t.colors.textMuted }]} />
        <Text style={poolStyles.providerName}>{name}</Text>
      </View>
    </View>
    <ProviderQuotaSkeleton testID="claude-gauge-loading" />
  </View>;
}

export function ClaudeProviderSection({
  nodeId,
  api,
  summaryProvider,
  loadingSummary,
  reloadKey,
  onTokenDeleted,
}: Props) {
  const jwt = useAuthStore(state => state.jwt);
  const [list, setList] = useState<ClaudeAccountList | null>(null);
  const [listUnavailable, setListUnavailable] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [loginStarting, setLoginStarting] = useState(false);
  const listRevision = useRef(0);
  const listRef = useRef<ClaudeAccountList | null>(null);
  const poolRef = useRef<ClaudeAccountPoolSectionHandle>(null);

  const applyList = useCallback((next: ClaudeAccountList | null) => {
    listRef.current = next;
    setList(next);
  }, []);

  useEffect(() => {
    applyList(null);
    setListUnavailable(false);
    setExpanded(false);
  }, [applyList, nodeId]);

  useEffect(() => {
    const request = ++listRevision.current;
    if (!nodeId) return;
    setListUnavailable(false);
    void api.getClaudeAuthAccounts(nodeId).then(result => {
      if (request === listRevision.current) applyList(result);
    }).catch(() => {
      // A failed refresh keeps the account screen the reader is already using.
      // The legacy fallback is only for a failed initial load.
      if (request === listRevision.current && listRef.current === null) setListUnavailable(true);
    });
    return () => { ++listRevision.current; };
  }, [api, applyList, nodeId, jwt, reloadKey]);

  const pool = list?.mode === 'pool' ? list : null;
  if (!list) {
    return <View testID="provider-row-claude">
      {listUnavailable
        ? <LegacyClaudeRow
          nodeId={nodeId}
          api={api}
          summaryProvider={summaryProvider}
          loadingSummary={loadingSummary}
          onTokenDeleted={onTokenDeleted}
        />
        : <ProviderHeaderLoading testID="provider-row-claude-loading" name="Claude" />}
    </View>;
  }

  if (pool) {
    return <PoolClaudeRow
      list={pool}
      summaryProvider={summaryProvider}
      loadingSummary={loadingSummary}
      expanded={expanded}
      onToggle={() => setExpanded(value => !value)}
      nodeId={nodeId}
      api={api}
      loginStarting={loginStarting}
      onLoginStartingChange={setLoginStarting}
      onListChange={applyList}
      poolRef={poolRef}
    />;
  }

  return <View testID="provider-row-claude">
    <LegacyClaudeRow
      nodeId={nodeId}
      api={api}
      summaryProvider={summaryProvider}
      loadingSummary={loadingSummary}
      onTokenDeleted={onTokenDeleted}
    />
  </View>;
}

function PoolClaudeRow({
  list,
  summaryProvider,
  loadingSummary,
  expanded,
  onToggle,
  nodeId,
  api,
  loginStarting,
  onLoginStartingChange,
  onListChange,
  poolRef,
}: {
  list: ClaudeAccountList;
  summaryProvider: AppUsageSummaryProvider | null;
  loadingSummary: boolean;
  expanded: boolean;
  onToggle(): void;
  nodeId: string;
  api: ClaudeProviderApi;
  loginStarting: boolean;
  onLoginStartingChange(starting: boolean): void;
  onListChange(list: ClaudeAccountList): void;
  poolRef: React.RefObject<ClaudeAccountPoolSectionHandle | null>;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeClaudePoolStyles(t), [t]);
  const cells = providerQuotaCells(summaryProvider);
  const summary = poolAvailabilityLabel(list.pool);
  const earliest = list.pool?.earliest_available_at;
  const blocked = list.pool !== null && list.pool.available_count < list.pool.total_count && earliest !== null;
  const sessionCount = list.accounts.reduce((total, account) => total + account.active_sessions, 0);
  const dotColor = list.pool && list.pool.available_count === 0 ? t.colors.warning : t.colors.success;

  return <View testID="provider-row-claude">
    <Pressable
      testID="claude-provider-header"
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={onToggle}
      style={styles.providerHeaderRow}
    >
      <View style={styles.accountHeaderRow}>
        <View style={styles.accountIdentity}>
          <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
          <Text style={styles.providerName}>Claude</Text>
          {summary ? <Text style={styles.metaText}>{summary}</Text> : null}
          {blocked ? <Text style={styles.blockedBadge}>{localClock(earliest ?? null) ?? ''} 해제</Text> : null}
          {sessionCount > 0 ? <Text style={styles.sessionText}>세션 {sessionCount}</Text> : null}
        </View>
        <View style={styles.headerControls}>
          {!expanded ? <Text style={styles.metaText}>계정 {list.accounts.length}</Text> : null}
          {expanded ? <GlassButton testID="claude-account-add" size="compact"
            accessibilityLabel="Claude 계정 추가" onPress={() => poolRef.current?.startLogin()} disabled={loginStarting}>
            {loginStarting ? <ActivityIndicator size="small" color={t.colors.accent} />
              : <>
                <Ionicons name="add" size={t.iconSize.compact} color={t.colors.accent} />
                <Text style={styles.accentButtonText}>계정 추가</Text>
              </>}
          </GlassButton> : null}
          <GlassButton testID="claude-provider-toggle" iconOnly size="compact" borderRadius={t.foundation.radius.round}
            accessibilityLabel={expanded ? '계정 접기' : '계정 펼치기'} onPress={onToggle}>
            <DisclosureIcon expanded={expanded} />
          </GlassButton>
        </View>
      </View>
      {loadingSummary ? <ProviderQuotaSkeleton testID="claude-gauge-loading" />
        : !expanded && cells.some(Boolean) ? <ProviderQuotaGrid prefix="provider-quota-claude" cells={cells} /> : null}
    </Pressable>
    {expanded ? <>
      <SettingsDivider />
      <ClaudeAccountPoolSection
        ref={poolRef}
        key={nodeId}
        showHeader={false}
        nodeId={nodeId}
        initialList={list}
        api={api}
        onListChange={onListChange}
        onLoginStartingChange={onLoginStartingChange}
      />
    </> : null}
  </View>;
}

function LegacyClaudeRow({
  nodeId,
  api,
  summaryProvider,
  loadingSummary,
  onTokenDeleted,
}: {
  nodeId: string;
  api: ClaudeProviderApi;
  summaryProvider: AppUsageSummaryProvider | null;
  loadingSummary: boolean;
  onTokenDeleted(): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const poolStyles = useMemo(() => makeClaudePoolStyles(t), [t]);
  const jwt = useAuthStore(state => state.jwt);
  const revision = useRef(0);
  const [authReload, setAuthReload] = useState(0);
  const [authStatus, setAuthStatus] = useState<{ has_token: boolean } | null>(null);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [codeValue, setCodeValue] = useState('');
  const [codeFocused, setCodeFocused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [claudeError, setClaudeError] = useState<string | null>(null);

  useEffect(() => {
    const request = ++revision.current;
    setAuthStatus(null); setProfile(null); setShowCodeInput(false); setCodeValue(''); setSubmitting(false); setLoginLoading(false); setClaudeError(null);
    if (!nodeId) return;
    setLoadingAuth(true);
    void (async () => {
      try {
        const status = await api.getClaudeAuthStatus(nodeId);
        if (request !== revision.current) return;
        setAuthStatus(status);
        if (status.has_token) {
          const next = await api.getClaudeProfile(nodeId);
          if (request === revision.current) setProfile(next);
        }
      } catch { if (request === revision.current) setClaudeError('계정 정보를 불러오지 못했습니다. 다시 시도해 주세요.'); }
      finally { if (request === revision.current) setLoadingAuth(false); }
    })();
    return () => { ++revision.current; };
  }, [api, nodeId, jwt, authReload]);

  async function handleRelogin() {
    const request = revision.current;
    setLoginLoading(true);
    setClaudeError(null);
    try {
      const { authUrl } = await api.startClaudeAuth(nodeId);
      if (request !== revision.current) return;
      await WebBrowser.openBrowserAsync(authUrl);
      if (request === revision.current) setShowCodeInput(true);
    } catch { if (request === revision.current) setClaudeError('인증 브라우저를 열지 못했습니다. 다시 시도해 주세요.'); }
    finally { if (request === revision.current) setLoginLoading(false); }
  }

  async function handleSubmitCode() {
    const code = codeValue.trim();
    if (!code) return;
    const request = revision.current;
    setSubmitting(true);
    setClaudeError(null);
    try {
      const response = await api.submitClaudeCode(nodeId, code);
      if (request !== revision.current) return;
      if (!response.ok) {
        setClaudeError('코드를 확인하고 다시 제출해 주세요.');
        return;
      }
      setShowCodeInput(false);
      setCodeValue('');
      setAuthReload(value => value + 1);
    } catch {
      if (request === revision.current) setClaudeError('인증에 실패했습니다. 다시 시도해 주세요.');
    } finally {
      if (request === revision.current) setSubmitting(false);
    }
  }

  async function handleDeleteToken() {
    const request = revision.current;
    setClaudeError(null);
    try {
      const response = await api.deleteClaudeToken(nodeId);
      if (request !== revision.current) return;
      if (!response.ok) {
        setClaudeError(`토큰 삭제 실패 (HTTP ${response.status})`);
        return;
      }
      setAuthStatus({ has_token: false });
      setProfile(null);
      onTokenDeleted();
    } catch {
      if (request === revision.current) setClaudeError('토큰 삭제 중 오류가 발생했습니다.');
    }
  }

  function confirmDeleteToken() {
    const request = revision.current;
    Alert.alert(
      '토큰 삭제',
      `${nodeId}의 Claude 인증 토큰을 삭제합니다. 계속하시겠습니까?`,
      [
        { text: '취소', style: 'cancel' },
        { text: '삭제', style: 'destructive', onPress: () => { if (request === revision.current) void handleDeleteToken(); } },
      ],
    );
  }

  const cells = providerQuotaCells(summaryProvider);
  const dotColor = authStatus === null ? t.colors.textMuted
    : authStatus.has_token ? t.colors.success : t.colors.textMuted;

  return <View testID="backend-provider-claude" style={[styles.provider, poolStyles.accountBlock]}>
    <View style={styles.headingRow}>
      <View style={poolStyles.accountIdentity}>
        <View style={[poolStyles.statusDot, { backgroundColor: dotColor }]} />
        <Text style={poolStyles.providerName}>Claude</Text>
        {profile ? <Text numberOfLines={1} style={styles.email}>{profile.email}</Text> : null}
        {profile?.has_claude_max ? <Text style={styles.badge}>Claude Max</Text> : null}
        {authStatus !== null ? <Text style={poolStyles.metaText}>{authStatus.has_token ? '인증됨' : '미인증'}</Text> : null}
      </View>
      <View style={styles.headingControls}>
        {loadingAuth ? <ActivityIndicator size="small" color={t.colors.accent} /> : null}
        <GlassButton
          testID="claude-login-action"
          iconOnly
          size="compact"
          borderRadius={t.foundation.radius.round}
          accessibilityLabel={authStatus?.has_token ? '재로그인' : '로그인'}
          onPress={handleRelogin}
          disabled={loginLoading}
        >
          {loginLoading ? <ActivityIndicator size="small" color={t.colors.accent} />
            : <Ionicons name={authStatus?.has_token ? 'refresh' : 'log-in-outline'} size={t.iconSize.compact} color={t.colors.textSecondary} />}
        </GlassButton>
        {authStatus?.has_token ? <GlassButton
          testID="claude-delete-action"
          iconOnly
          size="compact"
          borderRadius={t.foundation.radius.round}
          accessibilityLabel="토큰 삭제"
          onPress={confirmDeleteToken}
        >
          <Ionicons name="trash-outline" size={t.iconSize.compact} color={t.colors.textSecondary} />
        </GlassButton> : null}
      </View>
    </View>

    {claudeError ? <GlassButton accessibilityLabel="계정 다시 조회" onPress={() => setAuthReload(value => value + 1)}><Text style={styles.actionText}>계정 다시 조회</Text></GlassButton> : null}
    {showCodeInput ? <View style={styles.codeArea}>
      <Text style={styles.codeHint}>Anthropic 페이지에 표시된 코드를 붙여넣으세요.</Text>
      <TextInput
        testID="claude-code-input"
        accessibilityLabel="인증 코드"
        onFocus={() => setCodeFocused(true)} onBlur={() => setCodeFocused(false)}
        style={[styles.codeInput, codeFocused && { borderColor: t.colors.accent, backgroundColor: t.colors.accentTint }]}
        value={codeValue}
        onChangeText={setCodeValue}
        placeholder="YSrAXqZq...#7RVDts..."
        placeholderTextColor={t.colors.textPlaceholder}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={styles.actionRow}>
        <GlassButton testID="claude-code-confirm" style={styles.action} contentStyle={styles.buttonContent} onPress={handleSubmitCode} disabled={submitting}>
          {submitting ? <ActivityIndicator size="small" color={t.colors.accent} /> : <Text style={styles.actionText}>확인</Text>}
        </GlassButton>
        <GlassButton testID="claude-code-cancel" style={styles.action} contentStyle={styles.buttonContent} onPress={() => {
          ++revision.current; setSubmitting(false); setLoginLoading(false);
          setShowCodeInput(false);
          setCodeValue('');
          setClaudeError(null);
        }}>
          <Text style={styles.actionText}>취소</Text>
        </GlassButton>
      </View>
    </View> : null}

    {loadingSummary ? <ProviderQuotaSkeleton testID="claude-gauge-loading" />
      : cells.some(Boolean) ? <ProviderQuotaGrid prefix="provider-quota-claude" cells={cells} /> : null}
    {claudeError ? <Text accessibilityRole="alert" style={styles.error}>{claudeError}</Text> : null}
  </View>;
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    provider: { gap: t.spacing.md },
    headingRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md, minWidth: 0 },
    headingControls: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs, marginRight: -(t.hitTarget.min - t.foundation.iconFrame.compact) / 2 },
    email: { ...t.foundation.typography.body, minWidth: 0, flexShrink: 1, color: t.colors.textTertiary },
    badge: {
      ...t.foundation.typography.label,
      color: t.colors.link,
      backgroundColor: t.colors.accentTint,
      borderRadius: t.foundation.radius.chip,
      paddingHorizontal: t.spacing.xs,
      paddingVertical: t.spacing.xxs,
      overflow: 'hidden',
    },
    actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
    action: { flex: 1, minWidth: 120 },
    buttonContent: { minHeight: t.foundation.minHeight.secondary },
    actionText: { ...t.foundation.typography.body, color: t.colors.link, fontWeight: '600' },
    codeArea: { gap: t.spacing.sm },
    codeHint: { ...t.foundation.typography.body, color: t.colors.textTertiary },
    codeInput: {
      minHeight: t.foundation.minHeight.field,
      backgroundColor: t.colors.surfaceCode,
      color: t.colors.textPrimary,
      borderRadius: t.foundation.radius.field,
      borderWidth: 1,
      borderColor: t.colors.border,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      ...t.foundation.typography.mono,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    error: { ...t.foundation.typography.body, color: t.colors.errorText },
  });
}

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { createApiClient } from '../../api/client';
import type {
  AccountProfile,
  ProviderUsageSnapshot,
} from '../../api/claudeAuthTypes';
import { useTokens, type DesignTokens } from '../../theme';
import { useAuthStore } from '../../store/authStore';
import { GlassButton } from '../GlassSurface';
import { ProviderUsageChart } from '../ProviderUsageChart';

export function ClaudeProviderSection({
  nodeId,
  serverUrl,
  usage,
  loadingUsage,
  usageError,
  onRefreshUsage,
  onTokenDeleted,
  separateUsage = false,
}: {
  nodeId: string;
  serverUrl: string;
  usage: ProviderUsageSnapshot | null;
  loadingUsage: boolean;
  usageError: string | null;
  onRefreshUsage(): void;
  onTokenDeleted(): void;
  separateUsage?: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const jwt = useAuthStore(state => state.jwt);
  const revision = useRef(0);
  const [authReload, setAuthReload] = useState(0);
  const [authStatus, setAuthStatus] = useState<{ has_token: boolean } | null>(
    null,
  );
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [codeValue, setCodeValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [claudeError, setClaudeError] = useState<string | null>(null);

  useEffect(() => {
    const request = ++revision.current;
    setAuthStatus(null); setProfile(null); setShowCodeInput(false); setCodeValue(''); setSubmitting(false); setLoginLoading(false); setClaudeError(null);
    if (!serverUrl || !nodeId) return;
    setLoadingAuth(true);
    void (async () => {
      try {
        const api = createApiClient(serverUrl);
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
  }, [serverUrl, nodeId, jwt, authReload]);

  async function handleRelogin() {
    const request = revision.current;
    setLoginLoading(true);
    setClaudeError(null);
    try {
      const { authUrl } = await createApiClient(serverUrl).startClaudeAuth(
        nodeId,
      );
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
      const response = await createApiClient(serverUrl).submitClaudeCode(
        nodeId,
        code,
      );
      if (request !== revision.current) return;
      if (!response.ok) {
        setClaudeError('코드를 확인하고 다시 제출해 주세요.');
        return;
      }
      setShowCodeInput(false);
      setCodeValue('');
      setAuthReload(value => value + 1);
    } catch (error: any) {
      if (request === revision.current) setClaudeError('인증에 실패했습니다. 다시 시도해 주세요.');
    } finally {
      if (request === revision.current) setSubmitting(false);
    }
  }

  async function handleDeleteToken() {
    const request = revision.current;
    setClaudeError(null);
    try {
      const response = await createApiClient(serverUrl).deleteClaudeToken(
        nodeId,
      );
      if (request !== revision.current) return;
      if (!response.ok) {
        setClaudeError(`토큰 삭제 실패 (HTTP ${response.status})`);
        return;
      }
      setAuthStatus({ has_token: false });
      setProfile(null);
      onTokenDeleted();
    } catch (error: any) {
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

  const error = claudeError ?? (separateUsage ? null : usageError);

  return (
    <View testID="backend-provider-claude" style={styles.provider}>
      <View style={styles.headingRow}>
        <View style={styles.headingCopy}>
          <Text style={styles.title}>Claude Code</Text>
          {profile ? (
            <View style={styles.profileRow}>
              <Text style={styles.email} numberOfLines={1}>
                {profile.email}
              </Text>
              {profile.has_claude_max ? (
                <Text style={styles.badge}>Claude Max</Text>
              ) : null}
            </View>
          ) : null}
        </View>
        {loadingAuth ? (
          <ActivityIndicator size="small" color={t.colors.accent} />
        ) : (
          <View style={styles.status}>
            <Text style={styles.statusIcon}>
              {authStatus?.has_token ? '✓' : '—'}
            </Text>
            <Text style={styles.statusText}>
              {authStatus === null ? '조회 실패' : authStatus.has_token ? '인증됨' : '미인증'}
            </Text>
          </View>
        )}
      </View>

      {claudeError ? <GlassButton accessibilityLabel="계정 다시 조회" onPress={() => setAuthReload(value => value + 1)}><Text style={styles.actionText}>계정 다시 조회</Text></GlassButton> : null}
      {!showCodeInput ? (
        <View style={styles.actionRow}>
          <GlassButton
            testID="claude-login-action"
            surfaceTestID="claude-login-action-surface"
            style={styles.action}
            contentStyle={styles.buttonContent}
            onPress={handleRelogin}
            disabled={loginLoading}
          >
            {loginLoading ? (
              <ActivityIndicator size="small" color={t.colors.accent} />
            ) : (
              <Text style={styles.actionText}>
                {authStatus?.has_token ? '재로그인' : '로그인'}
              </Text>
            )}
          </GlassButton>
          {!separateUsage ? <GlassButton
            testID="claude-usage-action"
            surfaceTestID="claude-usage-action-surface"
            style={styles.action}
            contentStyle={styles.buttonContent}
            onPress={onRefreshUsage}
            disabled={loadingUsage}
          >
            {loadingUsage ? (
              <ActivityIndicator size="small" color={t.colors.accent} />
            ) : (
              <Text style={styles.actionText}>사용량</Text>
            )}
          </GlassButton> : null}
          {authStatus?.has_token ? (
            <GlassButton
              testID="claude-delete-action"
              surfaceTestID="claude-delete-action-surface"
              style={styles.action}
              contentStyle={styles.buttonContent}
              onPress={confirmDeleteToken}
            >
              <Text style={[styles.actionText, styles.destructive]}>삭제</Text>
            </GlassButton>
          ) : null}
        </View>
      ) : (
        <View style={styles.codeArea}>
          <Text style={styles.codeHint}>
            Anthropic 페이지에 표시된 코드를 붙여넣으세요.
          </Text>
          <TextInput
            testID="claude-code-input"
            style={styles.codeInput}
            value={codeValue}
            onChangeText={setCodeValue}
            placeholder="YSrAXqZq...#7RVDts..."
            placeholderTextColor={t.colors.textPlaceholder}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.actionRow}>
            <GlassButton
              testID="claude-code-confirm"
              surfaceTestID="claude-code-confirm-surface"
              style={styles.action}
              contentStyle={styles.buttonContent}
              onPress={handleSubmitCode}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator size="small" color={t.colors.accent} />
              ) : (
                <Text style={styles.actionText}>확인</Text>
              )}
            </GlassButton>
            <GlassButton
              testID="claude-code-cancel"
              surfaceTestID="claude-code-cancel-surface"
              style={styles.action}
              contentStyle={styles.buttonContent}
              onPress={() => {
                ++revision.current; setSubmitting(false); setLoginLoading(false);
                setShowCodeInput(false);
                setCodeValue('');
                setClaudeError(null);
              }}
            >
              <Text style={styles.actionText}>취소</Text>
            </GlassButton>
          </View>
        </View>
      )}

      {!separateUsage && usage ? <ProviderUsageChart usage={usage} providers={['claude']} /> : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    provider: { gap: t.spacing.md },
    headingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: t.spacing.md,
    },
    headingCopy: { flex: 1 },
    title: {
      ...t.foundation.typography.body,
      color: t.colors.textPrimary,
      fontWeight: '700',
    },
    profileRow: {
      marginTop: t.spacing.xs,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
    },
    email: {
      ...t.foundation.typography.body,
      color: t.colors.textTertiary,
      flex: 1,
    },
    badge: {
      ...t.foundation.typography.label,
      color: t.colors.link,
      backgroundColor: t.colors.accentTint,
      borderRadius: t.foundation.radius.chip,
      paddingHorizontal: t.spacing.xs,
      paddingVertical: t.spacing.xxs,
      overflow: 'hidden',
    },
    status: {
      minHeight: t.hitTarget.min,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.xs,
    },
    statusIcon: {
      ...t.foundation.typography.body,
      color: t.colors.textSecondary,
      fontWeight: '800',
    },
    statusText: {
      ...t.foundation.typography.body,
      color: t.colors.textSecondary,
    },
    actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
    action: { flex: 1, minWidth: 120 },
    buttonContent: { minHeight: t.foundation.minHeight.secondary },
    actionText: {
      ...t.foundation.typography.body,
      color: t.colors.link,
      fontWeight: '600',
    },
    destructive: { color: t.colors.errorText },
    codeArea: { gap: t.spacing.sm },
    codeHint: {
      ...t.foundation.typography.body,
      color: t.colors.textTertiary,
    },
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
    error: {
      ...t.foundation.typography.body,
      color: t.colors.errorText,
    },
  });
}

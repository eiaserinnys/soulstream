import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import { useSettingsStore } from '../store/settingsStore';
import { useAuthStore } from '../store/authStore';
import { useTokens, type DesignTokens } from '../theme';
import { useMemo } from 'react';
import { createSurfaceRoles } from '../theme/surfaceRoles';
import { GlassButton } from '../components/GlassSurface';

WebBrowser.maybeCompleteAuthSession();

const IOS_CLIENT_ID = (
  Constants.expoConfig?.extra as { iosOauthClientId?: string } | undefined
)?.iosOauthClientId;

/**
 * PKCE OAuth 로그인 화면.
 *
 * - expo-auth-session의 `useIdTokenAuthRequest`로 SFSafariViewController 기반 OAuth 진행.
 * - Google에서 받은 id_token을 백엔드 `/api/auth/google/native`로 POST → JWT 수신.
 * - 받은 JWT를 `useAuthStore.setJwt`로 저장 → RootNavigator가 jwt === non-null 파생으로
 *   TabNavigator로 자동 전환한다.
 *
 * iOS 클라이언트 ID는 `app.json`의 `extra.iosOauthClientId`에서 읽어 쓰며, 누락 시
 * 안내 화면을 노출한다 (명시적 실패 — 환경 누락은 조용히 넘어가지 않는다).
 */
export function LoginScreen() {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const serverUrl = useSettingsStore((s) => s.serverUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    iosClientId: IOS_CLIENT_ID,
  });

  useEffect(() => {
    if (!response) return;
    // expo-auth-session: response.type 으로 분기
    // ('success' | 'error' | 'dismiss' | 'cancel' | 'locked')
    if (response.type === 'success') {
      const idToken = response.params?.id_token;
      if (idToken) {
        handleIdToken(idToken);
      } else {
        setError('id_token이 응답에 없습니다.');
        setLoading(false);
      }
    } else if (response.type === 'error') {
      setError(
        'Google 로그인에 실패했습니다: ' + (response.error?.message ?? '')
      );
      setLoading(false);
    } else if (response.type === 'dismiss' || response.type === 'cancel') {
      setLoading(false);
    } else if (response.type === 'locked') {
      setError('다른 로그인 요청이 진행 중입니다. 잠시 후 다시 시도해주세요.');
      setLoading(false);
    }
  }, [response]);

  async function handleIdToken(idToken: string) {
    try {
      const res = await fetch(`${serverUrl}/api/auth/google/native`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_token: idToken }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.detail || `서버 오류 (${res.status})`);
      }
      const { token } = await res.json();
      useAuthStore.getState().setJwt(token);
      // → authDone === true → RootNavigator가 TabNavigator로 자동 전환
    } catch (e: any) {
      setError(e.message || '인증에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin() {
    setLoading(true);
    setError(null);
    try {
      await promptAsync();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '로그인 화면을 열지 못했습니다.');
      setLoading(false);
    }
  }

  if (!IOS_CLIENT_ID) {
    return (
      <SafeAreaView testID="login-safe-area" style={styles.container}>
        <Text style={styles.title}>설정 누락</Text>
        <Text style={styles.error} accessibilityRole="alert">
          app.json의 extra.iosOauthClientId가 설정되지 않았습니다.
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView testID="login-safe-area" style={styles.container}>
      <Text style={styles.title}>Soulstream</Text>
      <Text style={styles.subtitle}>소울스트림에 로그인</Text>

      <GlassButton
        variant="primary"
        testID="login-action"
        surfaceTestID="login-action-surface"
        style={styles.btn}
        contentStyle={styles.buttonContent}
        onPress={() => void handleLogin()}
        disabled={!request || loading}
      >
        {loading ? (
          <ActivityIndicator color={t.colors.accentText} />
        ) : (
          <Text style={styles.btnText}>Google로 로그인</Text>
        )}
      </GlassButton>

      {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
    </SafeAreaView>
  );
}

function makeStyles(t: DesignTokens) {
  const c = t.colors;
  const roles = createSurfaceRoles(t);
  return StyleSheet.create({
    container: {
      flex: 1,
      ...roles.canvas.tokenStyle,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: t.foundation.pageInset,
      paddingVertical: t.spacing.xxl,
    },
    title: {
      color: c.textPrimary,
      ...t.foundation.typography.display,
      marginBottom: t.spacing.sm,
    },
    subtitle: {
      color: c.textMuted,
      ...t.foundation.typography.section,
      marginBottom: t.spacing.xxxl,
    },
    btn: {
      minWidth: 240,
    },
    buttonContent: { minHeight: t.foundation.minHeight.primary },
    btnText: {
      color: c.accentText,
      ...t.foundation.typography.cardTitle,
    },
    error: {
      color: c.errorText,
      ...t.foundation.typography.body,
      marginTop: t.spacing.xl,
      textAlign: 'center',
    },
  });
}

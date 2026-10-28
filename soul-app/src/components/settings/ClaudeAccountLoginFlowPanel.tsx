import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ClaudeAuthLoginFlow } from '../../../../packages/soul-ui/src/lib/usage-summary';
import { useTokens } from '../../theme';
import { makeClaudePoolStyles } from './claudeAccountPoolStyles';
import { GlassButton } from '../GlassSurface';

type Props = {
  flow: ClaudeAuthLoginFlow;
  code: string;
  error: string | null;
  starting: boolean;
  submitting: boolean;
  cancelling: boolean;
  existingAccountCount: number;
  accountEmail: string | null;
  onOpenAuth(): void;
  onCodeChange(value: string): void;
  onSubmit(): void;
  onCancel(): void;
  onRestart(): void;
};

export function ClaudeAccountLoginFlowPanel({ flow, code, error, starting, submitting, cancelling,
  existingAccountCount, accountEmail, onOpenAuth, onCodeChange, onSubmit, onCancel, onRestart }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeClaudePoolStyles(t), [t]);
  const [codeFocused, setCodeFocused] = useState(false);
  const failed = flow.state === 'failed';
  const verifying = flow.state === 'code_submitted' || flow.state === 'verifying';
  const title = flow.account_id ? accountEmail ? `재로그인 (${accountEmail})` : '재로그인' : '새 Claude 계정 연결';
  const laterAccount = !flow.account_id && existingAccountCount > 0;
  return <View testID="claude-login-flow" style={styles.loginBlock}>
    <View style={styles.loginHeaderRow}>
      <Text style={styles.poolTitle}>{title}</Text>
      <Text style={[styles.statusBadge, failed && styles.dangerBadge]}>{failed ? '오류' : verifying ? '확인 중' : flow.state === 'done' ? '연결 완료' : '인증 필요'}</Text>
    </View>
    {error ? <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text> : null}
    {laterAccount ? <>
      <Text style={styles.statusBadge}>2번째 이후 계정</Text>
      <Text style={styles.loginNotice}>다른 계정은 시크릿 창이나 별도 브라우저 프로필에서 열어야 구분됩니다.</Text>
    </> : null}
    {flow.state === 'requested' || verifying ? <>
      <View style={styles.progressRow}>
        <ActivityIndicator size="small" color={t.colors.accent} />
        <Text style={styles.metaText}>{verifying ? '인증 코드를 확인하고 계정 정보를 가져오는 중입니다.' : '인증 링크를 준비하고 있습니다.'}</Text>
      </View>
      {!verifying ? <GlassButton testID="claude-login-cancel" accessibilityLabel="인증 취소" onPress={onCancel} disabled={cancelling}>
        <Text style={styles.secondaryButtonText}>{cancelling ? '취소 중' : '취소'}</Text>
      </GlassButton> : null}
    </> : null}
    {flow.state === 'url_ready' || failed ? <>
      <View style={styles.authActions}>
        <GlassButton testID="claude-login-open-auth" accessibilityLabel={failed ? '새 인증 링크 받기' : '인증 페이지 열기'} onPress={failed ? onRestart : onOpenAuth} disabled={failed ? starting : !flow.auth_url || starting} style={styles.flexButton}>
          <Ionicons name={failed ? 'refresh' : 'open-outline'} size={t.iconSize.compact} color={t.colors.accent} />
          <Text style={styles.accentButtonText}>{failed ? '새 인증 링크 받기' : '인증 페이지 열기'}</Text>
        </GlassButton>
        <GlassButton testID="claude-login-cancel" accessibilityLabel="인증 취소" onPress={onCancel} disabled={cancelling}>
          <Text style={styles.secondaryButtonText}>취소</Text>
        </GlassButton>
      </View>
      <TextInput testID="claude-login-code" accessibilityLabel="인증 코드" value={code} onChangeText={onCodeChange}
        placeholder={failed ? '새 인증 코드 붙여넣기 (code#state)' : '인증 코드 붙여넣기 (code#state)'} placeholderTextColor={t.colors.textMuted}
        onFocus={() => setCodeFocused(true)} onBlur={() => setCodeFocused(false)}
        style={[styles.codeInput, codeFocused && { borderColor: t.colors.accent, backgroundColor: t.colors.accentTint }]}
        autoCapitalize="none" autoCorrect={false} />
      <GlassButton testID="claude-login-submit" accessibilityLabel="인증 코드 확인" onPress={onSubmit}
        disabled={!code.trim() || submitting || verifying} variant="primary">
        {submitting ? <ActivityIndicator size="small" color={t.colors.accent} /> : <Text style={styles.primaryButtonText}>{failed ? '다시 확인' : '확인'}</Text>}
      </GlassButton>
    </> : null}
    {flow.state === 'code_submitted' || flow.state === 'verifying' ? <GlassButton testID="claude-login-cancel" accessibilityLabel="인증 취소" onPress={onCancel} disabled={cancelling || submitting}>
      <Text style={styles.secondaryButtonText}>{cancelling ? '취소 중' : '취소'}</Text>
    </GlassButton> : null}
  </View>;
}

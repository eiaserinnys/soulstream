import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { ApiClient } from '../../api/client';
import {
  loadMorningReviewQueue,
  type MorningReviewAction,
  type MorningReviewItem,
} from '../../lib/morning-review';
import { plannerCompletionErrorText } from '../../lib/planner-completion-error';
import { useTokens, type DesignTokens } from '../../theme';
import { AppModalSurface } from '../AppModalSurface';
import { GlassButton } from '../GlassSurface';

type LoadState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; items: MorningReviewItem[] }
  | { status: 'error'; message: string };

export function MorningReviewSheet({
  visible,
  api,
  today,
  onClose,
  onAction,
}: {
  visible: boolean;
  api: ApiClient | null;
  today: string;
  onClose(): void;
  onAction(item: MorningReviewItem, action: MorningReviewAction): Promise<void>;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' });
  const [index, setIndex] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const generation = useRef(0);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    const currentGeneration = ++generation.current;
    if (!visible) {
      setLoadState({ status: 'idle' });
      return;
    }
    setIndex(0);
    setProcessing(false);
    setActionError(null);
    if (!api) {
      setLoadState({ status: 'error', message: '서버 연결을 먼저 설정해야 합니다.' });
      return;
    }
    setLoadState({ status: 'loading' });
    void loadMorningReviewQueue(api, today).then((items) => {
      if (currentGeneration === generation.current && visibleRef.current) {
        setLoadState({ status: 'ready', items });
      }
    }).catch((cause: unknown) => {
      if (currentGeneration === generation.current && visibleRef.current) {
        setLoadState({ status: 'error', message: errorText(cause) });
      }
    });
    return () => { generation.current += 1; };
  }, [api, retryNonce, today, visible]);

  const items = loadState.status === 'ready' ? loadState.items : [];
  const item = items[index] ?? null;
  const complete = loadState.status === 'ready' && index >= items.length;
  const runAction = async (action: MorningReviewAction) => {
    if (!item || processing) return;
    setProcessing(true);
    setActionError(null);
    try {
      await onAction(item, action);
      if (visibleRef.current) setIndex((value) => value + 1);
    } catch (cause) {
      if (visibleRef.current) {
        setActionError(action === 'done'
          ? plannerCompletionErrorText(cause)
          : errorText(cause));
      }
    } finally {
      if (visibleRef.current) setProcessing(false);
    }
  };

  return (
    <AppModalSurface
      visible={visible}
      variant="compact"
      modalId="modal_morning_review"
      onRequestClose={onClose}
      surfaceTestID="morning-review-modal"
      safeAreaTestID="morning-review-safe-area"
    >
      <View testID="morning-review-header" style={styles.header}>
            <View style={styles.headerSpacer} />
            <Text style={styles.headerTitle} accessibilityRole="header">오늘 작업 검토</Text>
            <TouchableOpacity
              testID="morning-review-close"
              style={styles.headerAction}
              onPress={onClose}
              accessibilityLabel="오늘 작업 검토 닫기"
            >
              <Text style={styles.closeText}>닫기</Text>
            </TouchableOpacity>
      </View>
      <ScrollView
            testID="morning-review-content"
            contentContainerStyle={styles.content}
            accessibilityLiveRegion="polite"
          >
            {loadState.status === 'loading' ? (
              <View testID="morning-review-loading" style={styles.message}>
                <ActivityIndicator color={t.colors.accent} />
                <Text style={styles.meta}>이월할 카드를 모으는 중…</Text>
              </View>
            ) : null}
            {loadState.status === 'error' ? (
              <View testID="morning-review-load-error" style={styles.message} accessibilityRole="alert">
                <Text style={styles.error}>검토할 카드를 불러오지 못했습니다.</Text>
                <Text style={styles.meta}>{loadState.message}</Text>
                <GlassButton
                  testID="morning-review-retry"
                  onPress={() => setRetryNonce((value) => value + 1)}
                  contentStyle={styles.retry}
                >
                  <Text style={styles.buttonText}>다시 시도</Text>
                </GlassButton>
              </View>
            ) : null}
            {item ? (
              <View testID={`morning-review-item-${item.folder.page.id}`} style={styles.item}>
                <Text style={styles.label}>미완 카드 · {displayDate(item.sourceDate)}</Text>
                <Text style={styles.title} accessibilityLabel={item.folder.page.title}>
                  {item.folder.page.title}
                </Text>
                <Text style={styles.meta}>{item.folder.assignee || '담당 없음'}</Text>
                {actionError ? (
                  <Text testID="morning-review-action-error" style={styles.error} accessibilityRole="alert">
                    {actionError}
                  </Text>
                ) : null}
                <View style={styles.actions}>
                  <GlassButton
                    testID="morning-review-today"
                    variant="primary"
                    disabled={processing}
                    onPress={() => { void runAction('today'); }}
                    contentStyle={styles.action}
                  >
                    <Text style={styles.primaryText}>오늘로</Text>
                  </GlassButton>
                  <GlassButton
                    testID="morning-review-later"
                    disabled={processing}
                    onPress={() => { void runAction('later'); }}
                    contentStyle={styles.action}
                  >
                    <Text style={styles.buttonText}>미루기</Text>
                  </GlassButton>
                  <GlassButton
                    testID="morning-review-done"
                    disabled={processing}
                    onPress={() => { void runAction('done'); }}
                    contentStyle={styles.action}
                  >
                    <Text style={styles.buttonText}>완료 처리</Text>
                  </GlassButton>
                </View>
                <Text style={styles.progress} accessibilityLabel="오늘 작업 검토 진행률">
                  {index + 1} / {items.length}
                </Text>
              </View>
            ) : null}
            {complete ? (
              <View testID="morning-review-complete" style={styles.message}>
                <Text style={styles.title}>{items.length === 0 ? '검토할 카드가 없습니다.' : '오늘 준비 완료'}</Text>
                <Text style={styles.meta}>결정한 카드를 오늘 플래너에 반영했습니다.</Text>
              </View>
            ) : null}
      </ScrollView>
    </AppModalSurface>
  );
}

function displayDate(date: string): string {
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric' })
    .format(new Date(`${date}T12:00:00`));
}

function errorText(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : String(cause);
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    header: {
      minHeight: t.hitTarget.min + t.spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: t.foundation.pageInset,
    },
    headerSpacer: { minWidth: t.hitTarget.min },
    headerTitle: {
      flex: 1,
      textAlign: 'center',
      color: t.colors.textPrimary,
      ...t.foundation.typography.navigation,
    },
    headerAction: {
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      alignItems: 'flex-end',
      justifyContent: 'center',
    },
    closeText: { color: t.colors.accent, ...t.foundation.typography.body, fontWeight: '700' },
    content: {
      paddingHorizontal: t.foundation.pageInset,
      paddingVertical: t.spacing.lg,
      gap: t.spacing.md,
    },
    message: { minHeight: t.foundation.minHeight.memo, alignItems: 'center', justifyContent: 'center', gap: t.spacing.sm },
    item: { gap: t.spacing.md },
    label: { color: t.colors.textSecondary, ...t.foundation.typography.label },
    title: { color: t.colors.textPrimary, ...t.foundation.typography.section },
    meta: { color: t.colors.textTertiary, ...t.foundation.typography.meta },
    error: { color: t.colors.errorText, ...t.foundation.typography.meta },
    actions: { gap: t.spacing.sm },
    action: { minHeight: t.foundation.minHeight.secondary, paddingHorizontal: t.spacing.md },
    retry: { minHeight: t.foundation.minHeight.secondary, paddingHorizontal: t.spacing.md },
    primaryText: { color: t.colors.accentText, ...t.foundation.typography.body, fontWeight: '700' },
    buttonText: { color: t.colors.textPrimary, ...t.foundation.typography.body, fontWeight: '600' },
    progress: { color: t.colors.textSecondary, ...t.foundation.typography.meta, textAlign: 'center' },
  });
}

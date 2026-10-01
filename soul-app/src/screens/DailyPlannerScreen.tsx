import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ActivityIndicator, Alert, RefreshControl, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { createApiClient } from '../api/client';
import type { PlannerFolder } from '../api/plannerTypes';
import { DailyMemo } from '../components/planner/DailyMemo';
import { CardComposer } from '../components/planner/CardComposer';
import { AppKeyboardAvoidingView } from '../components/AppKeyboardAvoidingView';
import { GlassButton } from '../components/GlassSurface';
import { TodayCards } from '../components/planner/TodayCards';
import { usePlannerDaily } from '../hooks/usePlannerReads';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../theme';
import { createSurfaceRoles } from '../theme/surfaceRoles';
import { usePlannerActions } from '../hooks/usePlannerActions';
import { useSessionStore } from '../store/sessionStore';
import { NewFolderSheet } from '../components/planner/NewFolderSheet';
import { MorningReviewSheet } from '../components/planner/MorningReviewSheet';
import {
  dispatchMorningReviewAction,
  type MorningReviewAction,
  type MorningReviewItem,
} from '../lib/morning-review';

export interface DailyPlannerScreenHandle {
  openReview(): void;
  openNewFolder(): void;
}

export const DailyPlannerScreen = forwardRef<DailyPlannerScreenHandle, {
  active?: boolean;
  date?: string;
  layout?: 'phone' | 'tablet';
  onOpenSession?: (sessionId: string) => void;
  onDateChange?: (date: string) => void;
  onOpenFolder?: (folder: PlannerFolder) => void;
}>(function DailyPlannerScreen({
  active = true,
  date: controlledDate,
  layout = 'phone',
  onDateChange,
  onOpenFolder,
  onOpenSession,
}, ref) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t, layout), [layout, t]);
  const [localDate, setLocalDate] = useState(todayDate);
  const scrollRef = useRef<ScrollView>(null);
  const previousDate = useRef(controlledDate ?? localDate);
  const previousActive = useRef(active);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [draggingCards, setDraggingCards] = useState(false);
  const today = useUIStore((state) => state.todayDate);
  const refreshTodayDate = useUIStore((state) => state.refreshTodayDate);
  const previousToday = useRef(today);
  useEffect(() => {
    if (active) refreshTodayDate(new Date());
  }, [active, refreshTodayDate]);
  useEffect(() => {
    if (active && localDate === previousToday.current && today !== previousToday.current) {
      setLocalDate(today);
    }
    previousToday.current = today;
  }, [active, localDate, today]);
  const date = controlledDate ?? localDate;
  const resetScroll = useCallback(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, []);
  useLayoutEffect(() => {
    const dateChanged = previousDate.current !== date;
    const becameActive = active && !previousActive.current;
    if (dateChanged || becameActive) resetScroll();
    previousDate.current = date;
    previousActive.current = active;
  }, [active, date, resetScroll]);
  const setDate = (next: string) => {
    if (next === date) return;
    resetScroll();
    previousDate.current = next;
    if (controlledDate === undefined) setLocalDate(next);
    onDateChange?.(next);
  };
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const actions = usePlannerActions(api);
  const folders = useSessionStore((state) => state.catalog.folders);
  const [newFolderVisible, setNewFolderVisible] = useState(false);
  const [reviewVisible, setReviewVisible] = useState(false);
  const { data, loading, error, refresh } = usePlannerDaily(api, date, active);
  const handlePullRefresh = useCallback(async () => {
    if (pullRefreshing) return;
    setPullRefreshing(true);
    try {
      await refresh();
    } finally {
      setPullRefreshing(false);
    }
  }, [pullRefreshing, refresh]);
  useImperativeHandle(ref, () => ({
    openReview: () => setReviewVisible(true),
    openNewFolder: () => setNewFolderVisible(true),
  }), []);
  const applyReviewAction = useCallback(async (
    item: MorningReviewItem,
    action: MorningReviewAction,
  ) => dispatchMorningReviewAction(item, action, {
    mountToday: async (folder) => { await actions.setFolderToday(folder, today, true); },
    completeFolder: async (folder) => { await actions.completeFolder(folder); },
  }), [actions, today]);
  return (
    <AppKeyboardAvoidingView testID="daily-keyboard-frame" style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView
      ref={scrollRef}
      testID="phone-daily-body"
      scrollEnabled={!draggingCards}
      style={styles.container}
      contentContainerStyle={styles.content}
      contentInset={{ top: 0, right: 0, bottom: 0, left: 0 }}
      refreshControl={(
        <RefreshControl refreshing={pullRefreshing} onRefresh={handlePullRefresh} />
      )}
    >
      <View testID="daily-date-row" style={styles.dateRow}>
        <Text style={styles.kicker}>DAILY</Text>
        <Text testID="daily-centered-date" style={styles.date} numberOfLines={1}>{formatDailyDate(date)}</Text>
        <View style={styles.dateActions}>
        <GlassButton iconOnly borderRadius={t.foundation.radius.round}
          accessibilityLabel="이전 날짜"
          onPress={() => setDate(shiftDate(date, -1))}
        >
          <Text style={styles.dateButton}>‹</Text>
        </GlassButton>
        <GlassButton iconOnly borderRadius={t.foundation.radius.round}
          accessibilityLabel="다음 날짜"
          onPress={() => setDate(shiftDate(date, 1))}
        >
          <Text style={styles.dateButton}>›</Text>
        </GlassButton>
        </View>
        {loading && !pullRefreshing ? (
          <ActivityIndicator
            testID="daily-auto-progress"
            color={t.colors.accent}
            style={styles.autoProgress}
          />
        ) : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {data ? (
        <DailyMemo
          blocks={data.memoBlocks}
          onSave={(blockId, text) => actions.saveDailyMemo(
            date,
            data.daily.page.id,
            blockId,
            text,
          ).catch((saveError) => {
            Alert.alert(
              '메모를 저장하지 못했습니다.',
              saveError instanceof Error ? saveError.message : String(saveError),
            );
            throw saveError;
          })}
        />
      ) : null}
      <TodayCards api={api} data={data} onOpenSession={onOpenSession} onDragStateChange={setDraggingCards} />
    </ScrollView>
    <View testID="daily-composer-dock" style={styles.dock}><CardComposer today api={api} onSessionCreated={onOpenSession} /></View>
      <NewFolderSheet
        visible={newFolderVisible}
        api={api}
        folders={folders}
        dailyDate={today}
        onClose={() => setNewFolderVisible(false)}
        onSubmit={actions.createFolder}
      />
      <MorningReviewSheet
        visible={reviewVisible}
        api={api}
        today={today}
        onClose={() => setReviewVisible(false)}
        onAction={applyReviewAction}
      />
    </AppKeyboardAvoidingView>
  );
});

function todayDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function shiftDate(value: string, amount: number): string {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDailyDate(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${date.toLocaleDateString('ko-KR', { weekday: 'long' })}`;
}

function makeStyles(t: DesignTokens, layout: 'phone' | 'tablet') {
  const roles = createSurfaceRoles(t);
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    container: { flex: 1, ...roles.canvas.tokenStyle },
    content: {
      paddingHorizontal: t.uiSpacing.lg,
      paddingVertical: t.spacing.lg,
      gap: t.uiSpacing.lg,
    },
    dock: { paddingHorizontal: t.uiSpacing.lg, paddingTop: t.uiSpacing.sm + t.uiSpacing.xxs,
      paddingBottom: t.uiSpacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.border },
    dateRow: {
      position: 'relative',
      minHeight: planner.minHeight.context,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.sm,
    },
    kicker: { ...planner.typography.meta, fontWeight: planner.typography.section.fontWeight,
      color: t.colors.textSecondary, letterSpacing: t.uiSpacing.xxs },
    dateActions: { flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xs },
    autoProgress: {
      position: 'absolute',
      right: planner.actionColumn + t.uiSpacing.sm,
    },
    date: {
      color: t.colors.textPrimary,
      ...planner.typography.navigation,
      flex: 1,
    },
    dateButton: { color: t.colors.textSecondary, fontSize: t.iconSize.standard },
    error: { color: t.colors.errorText, ...planner.typography.body },
  });
}

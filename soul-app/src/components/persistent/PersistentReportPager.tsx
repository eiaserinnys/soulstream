import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, findNodeHandle, Keyboard, Platform, ScrollView, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ApiClient } from '../../api/client';
import type { PersistentReportEntry } from '../../api/types';
import type { ReportReplyDraft } from '../../lib/persistent-report';
import { useOpenContentLink } from '../../hooks/useOpenContentLink';
import { useDeviceType, useTokens } from '../../theme';
import { LiquidGlassButton } from '../LiquidGlassButton';
import { chatAuxiliarySurface } from '../chat/chatAuxiliarySurface';
import type { AppendGeneratedTextResult } from '../chat/ChatInputComposer';
import { PersistentReportSheet, reportTag, reportWebProps } from './PersistentReportSheet';
import { reportStyles } from './persistentReportStyles';

export function PersistentReportPager({ entries, index, api, onSelect, onDismiss, onAppend, onFocusComposer }: {
  entries: PersistentReportEntry[]; index: number; api: ApiClient | null;
  onSelect(index: number): void; onDismiss(key: string): Promise<void>;
  onAppend(text: string, reply: ReportReplyDraft): AppendGeneratedTextResult; onFocusComposer(): void;
}) {
  const t = useTokens();
  const phone = useDeviceType() === 'phone';
  const bleed = phone ? t.foundation.pageInset : t.uiSpacing.lg;
  const styles = useMemo(() => reportStyles(t, bleed, !phone), [t, bleed, phone]);
  const [keyboard, setKeyboard] = useState(Keyboard.isVisible());
  useEffect(() => {
    if (!phone) return;
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboard(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboard(false));
    return () => { show.remove(); hide.remove(); };
  }, [phone]);
  const compact = phone && keyboard;
  const scroll = useRef<ScrollView>(null);
  const deck = useRef<View>(null);
  const sheetNodes = useRef<Record<string, View | null>>({});
  const [width, setWidth] = useState(0);
  const expectedScroll = useRef<number | null>(null);
  const scrollOffset = useRef(0);
  const moveFocus = useRef(false);
  const count = entries.length;
  const key = entries[index]?.key;
  const keys = JSON.stringify(entries.map(entry => entry.key));
  const openLink = useOpenContentLink();
  const align = () => {
    if (!width) return;
    expectedScroll.current = Math.abs(scrollOffset.current - index * width) > 1 ? index * width : null;
    scroll.current?.scrollTo({ x: index * width, animated: false });
  };
  useLayoutEffect(align, [width, keys, index]);
  const page = `${index + 1} / ${count}`;
  const announced = useRef(key);
  useEffect(() => {
    if (announced.current === key) return;
    announced.current = key;
    if (key && Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility(count > 1 ? page : reportTag(entries[index]));
    if (!moveFocus.current) return;
    moveFocus.current = false;
    const target = key ? sheetNodes.current[key] : null;
    if (!target) { onFocusComposer(); return; }
    if (Platform.OS === 'web') (target as unknown as HTMLElement).focus({ preventScroll: true });
    else { const handle = findNodeHandle(target); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); }
  }, [key, count, page, entries, index, onFocusComposer]);
  const focusInside = () => Platform.OS === 'web'
    && !!(deck.current as unknown as HTMLElement | null)?.contains(document.activeElement);
  const previousKey = useRef(key);
  if (previousKey.current !== key && focusInside()) moveFocus.current = true;
  previousKey.current = key;
  const step = (by: number) => {
    if (Platform.OS !== 'web' || focusInside()) moveFocus.current = true;
    onSelect(Math.max(0, Math.min(count - 1, index + by)));
  };
  const expand = () => { Keyboard.dismiss(); setKeyboard(false); };
  async function openCard(number: number) {
    if (!api) return;
    try {
      const { cards } = await api.listCards(undefined, { includeCompleted: true });
      const card = cards.find(card => card.number === number);
      if (!card) throw Error('missing');
      await openLink(`/?card=${encodeURIComponent(card.id)}`);
    } catch { Alert.alert('카드를 열지 못했습니다.'); }
  }
  // RN 0.86 View exposes nativeEvent.key; RN web exposes key directly.
  const onKeyDown = (event: { key?: string; nativeEvent?: { key?: string }; preventDefault?(): void }) => {
    const key = event.nativeEvent?.key ?? event.key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
    event.preventDefault?.(); step(key === 'ArrowRight' ? 1 : -1);
  };
  if (!count) return null;
  return <View ref={deck} testID="report-deck" accessibilityLabel="지금의 보고" accessible={false}
    style={[chatAuxiliarySurface(t, 'manuscript'), styles.deck]} {...reportWebProps({ role: 'region' })}
    {...{ onKeyDown }}>
    <ScrollView ref={scroll} testID="report-track" horizontal pagingEnabled showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled" contentContainerStyle={styles.track}
      onLayout={event => setWidth(event.nativeEvent.layout.width)} onContentSizeChange={align}
      onScroll={event => {
        if (!width) return;
        const x = event.nativeEvent.contentOffset.x;
        scrollOffset.current = x;
        if (expectedScroll.current !== null) {
          if (Math.abs(x - expectedScroll.current) > 1) return;
          expectedScroll.current = null;
        }
        const next = Math.max(0, Math.min(count - 1, Math.round(x / width)));
        if (next !== index) { if (focusInside()) moveFocus.current = true; onSelect(next); }
      }} scrollEventThrottle={16}>
      {width > 0 ? entries.map((entry, i) => <PersistentReportSheet key={`${entry.key}-${width}`} entry={entry}
        index={i} count={count} current={i === index} compact={compact} showNav={!phone} width={width} styles={styles}
        nodeRef={node => { sheetNodes.current[entry.key] = node; }} onStep={step} onExpand={expand}
        onDismiss={() => { moveFocus.current = Platform.OS !== 'web' || focusInside(); void onDismiss(entry.key); }}
        onOption={option => {
          const text = `${entry.title}: ${option}`;
          const result = onAppend(text, { key: entry.key, option, text });
          if (!result.ok) Alert.alert(result.reason === 'too_long' ? '입력창이 가득 차서 더하지 못했어.' : '지금은 입력창에 더할 수 없어.');
        }} onCard={number => void openCard(number)} onLink={url => void openLink(url)} />) : null}
    </ScrollView>
    {count > 1 && !phone ? <View testID="report-nav" style={styles.nav}>
      <LiquidGlassButton iconOnly variant="plain" size="compact" accessibilityLabel="앞 장" disabled={index === 0} onPress={() => step(-1)}>
        <Ionicons name="chevron-back" size={t.iconSize.navigation} color={index === 0 ? t.colors.textPlaceholder : t.colors.textPrimary} />
      </LiquidGlassButton>
      <Text testID="report-count" aria-live="polite" style={styles.count}>{page}</Text>
      <LiquidGlassButton iconOnly variant="plain" size="compact" accessibilityLabel="다음 장" disabled={index === count - 1} onPress={() => step(1)}>
        <Ionicons name="chevron-forward" size={t.iconSize.navigation} color={index === count - 1 ? t.colors.textPlaceholder : t.colors.textPrimary} />
      </LiquidGlassButton>
    </View> : null}
  </View>;
}

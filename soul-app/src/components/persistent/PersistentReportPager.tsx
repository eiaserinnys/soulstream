import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, findNodeHandle, Keyboard, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ApiClient } from '../../api/client';
import type { PersistentReportEntry } from '../../api/types';
import type { CardQuestionView } from '../planner/card-question-viewmodel';
import { useOpenContentLink } from '../../hooks/useOpenContentLink';
import { isPersistentReportCardExpandable, isReviewCardEntry, isServerCardAcknowledgement } from '../../lib/persistent-report-card';
import { useDeviceType, useTokens } from '../../theme';
import { LiquidGlassButton } from '../LiquidGlassButton';
import { useChatUiActions } from '../chat-ui/ChatUiControllerProvider';
import { PersistentReportSheet, PersistentReportUndoRow, reportTag, reportWebProps } from './PersistentReportSheet';
import { reportStyles } from './persistentReportStyles';
import type { usePersistentReportSend } from './usePersistentReportSend';
import type { CardCompletion } from './usePersistentCardCompletion';
import { ReportComposerFocusContext, useReportComposerScroll } from './useReportComposerScroll';

/** 계약 판 8, 3절 2번: 답한 장은 펼치지 않은 채 이만큼 지나면 놓는다. */
export const CARD_QUESTION_ANSWERED_HOLD_MS = 10_000;

function ReportNavButton({ interaction, testID, ...props }: React.ComponentProps<typeof LiquidGlassButton> & { interaction(pressed: boolean): void }) {
  const held = useRef(false);
  const release = () => { if (held.current) { held.current = false; interaction(false); } };
  useEffect(() => () => release(), [interaction]);
  useEffect(() => { if (props.disabled) release(); }, [props.disabled]);
  return <View testID={testID} onTouchStart={() => { if (!props.disabled) { held.current = true; interaction(true); } }}
    onTouchEnd={release} onTouchCancel={release}>
    <LiquidGlassButton {...props} />
  </View>;
}

export function PersistentReportPager({ entries: rawEntries, index: rawIndex, api, onSelect, onDismiss, onFocusComposer, send, bubble = false, maxHeight, onInteraction, onDeckTouch, onReady, sessionId, renderCardDetails, renderCardStatus, renderQuestion, onOpenCardDetails, expandedKey: controlledExpandedKey, onExpandedKeyChange, completion, verticalList = false, revealKey, onRevealed, answeredHoldKey, onAnsweredHoldExpire, handling = false }: {
  expandedKey?: string | null; onExpandedKeyChange?(key: string | null): void;
  /** 답한 장을 확정한 붙들기 key. 있으면 펼치지 않은 동안 기한을 센다. */
  answeredHoldKey?: string | null; onAnsweredHoldExpire?(key: string): void;
  renderCardDetails?(entry: PersistentReportEntry, publishQuestionView: (view: CardQuestionView | null) => void): React.ReactNode;
  renderCardStatus?(entry: PersistentReportEntry): React.ReactNode;
  /** 카드 #1197: 질문 장은 본문과 동작 줄을 이 함수가 그린다. */
  renderQuestion?(entry: PersistentReportEntry, controls: { expanded: boolean; expand(): void; detailView: CardQuestionView | null }): { body: React.ReactNode; actions: React.ReactNode; meta?: React.ReactNode } | null;
  onOpenCardDetails?(entry: PersistentReportEntry): void;
  entries: PersistentReportEntry[]; index: number; api: ApiClient | null;
  onSelect(index: number): void; onDismiss(key: string): Promise<boolean | void>;
  onFocusComposer(): void;
  send?: ReturnType<typeof usePersistentReportSend>; bubble?: boolean; maxHeight?: number; onInteraction?(pressed: boolean): void;
  onDeckTouch?(active: boolean): void; onReady?(ready: boolean): void; sessionId?: string;
  completion?: CardCompletion; verticalList?: boolean; revealKey?: string | null; onRevealed?(): void;
  /** 판을 다루는 동안(터치가 판 안에서 시작해 판 밖에서 다시 시작될 때까지) 위에 붙은 띠가 줄지 않는다. */
  handling?: boolean;
}) {
  const entries = useMemo(() => completion?.filterEntries ? completion.filterEntries(rawEntries) : rawEntries, [completion, rawEntries]);
  const index = Math.min(rawIndex, Math.max(0, entries.length - 1));
  const [localExpandedKey, setLocalExpandedKey] = useState<string | null>(null);
  const expandedKey = controlledExpandedKey === undefined ? localExpandedKey : controlledExpandedKey;
  const setExpandedKey = onExpandedKeyChange ?? setLocalExpandedKey;
  // 펼쳐 둔 동안에는 시간을 세지 않고, 접으면 그때부터 다시 센다. 카드 시트를 여는 것은
  // 판의 펼침이 아니므로(계약 판 3) expandedKey가 바뀌지 않는 한 시간을 센다.
  useEffect(() => {
    if (!answeredHoldKey || expandedKey === answeredHoldKey) return;
    const timer = setTimeout(() => onAnsweredHoldExpire?.(answeredHoldKey), CARD_QUESTION_ANSWERED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [answeredHoldKey, expandedKey, onAnsweredHoldExpire]);
  // 펼친 장이 읽은 카드 상세의 질문 보기. 펼친 장이 접히면 지운다(계약 1.4절 마지막 줄).
  const [detailQuestionView, setDetailQuestionView] = useState<{ key: string; view: CardQuestionView | null } | null>(null);
  const publishDetailQuestionView = useCallback((key: string, view: CardQuestionView | null) => {
    setDetailQuestionView(current => current && current.key === key && current.view === view ? current : { key, view });
  }, []);
  const t = useTokens();
  const { setNotice } = useChatUiActions();
  const phone = useDeviceType() === 'phone';
  const bleed = phone ? t.foundation.pageInset : t.uiSpacing.lg;
  const styles = useMemo(() => reportStyles(t, bleed, !phone), [t, bleed, phone]);
  const inlineExpanded = !bubble && expandedKey !== null && renderCardDetails !== undefined;
  const [keyboard, setKeyboard] = useState(Keyboard.isVisible());
  useEffect(() => {
    if (!phone && bubble) return;
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboard(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboard(false));
    return () => { show.remove(); hide.remove(); };
  }, [phone, bubble]);
  const compact = keyboard && !bubble && !inlineExpanded;
  // The deck cap must leave the band's outer margins inside its placement budget.
  const bandMargin = StyleSheet.flatten(styles.band).marginVertical as number;
  const inlineMaxHeight = maxHeight === undefined ? undefined : Math.max(0, maxHeight - bandMargin * 2);
  const [width, setWidth] = useState(0);
  const measuredHeights = useRef(new Map<string, number>());
  const readyHeights = useRef(new Set<string>());
  const openHeights = useRef(new Map<string, number>());
  const measureKey = (entry: PersistentReportEntry) => JSON.stringify([sessionId, bubble, compact, width, entry.key, expandedKey === entry.key, entry.title, entry.context, entry.action, entry.options, entry.card_numbers, entry.card_id, entry.card_status]);
  const pressing = useRef(false);
  // pagingEnabled snaps a drag that stops between pages; the height settles when it lands.
  const sliding = useRef(false);
  const [height, setHeight] = useState(0);
  const layoutKey = JSON.stringify([sessionId, bubble, compact, width]);
  // 위에 붙은 아이패드 띠에서만 다루기 붙들기를 건다. 말풍선, 폰 띠, 키보드가 뜬 배치는 그대로다.
  const bandHandling = handling && !bubble && !phone && !compact && !verticalList && entries.length > 1;
  const heldHeight = useRef(0);
  const heldLayout = useRef<string | null>(null);
  const [presentedLayout, setPresentedLayout] = useState<string | null>(null);
  const presentedSession = useRef(sessionId);
  const commitHeight = () => {
    if (bandHandling) {
      if (heldLayout.current !== layoutKey) { heldLayout.current = layoutKey; heldHeight.current = Math.max(0, height); }
    } else if (heldLayout.current !== null) { heldLayout.current = null; heldHeight.current = 0; }
    const allMeasured = width > 0 && entries.every(entry => readyHeights.current.has(measureKey(entry)));
    // 다루기 붙들기가 걸린 아이패드 띠는 손가락이 판 안에 있는 동안에도 지금 장 높이를 잰다.
    // 붙들기가 줄어듦을 막으므로 누르기·끌기 대기는 이 경우에 필요 없다(긴 장으로 넘기면 자란다).
    if ((!bandHandling && (pressing.current || sliding.current))
      || (bubble && !entries.every(entry => measuredHeights.current.has(measureKey(entry))))
      || (presentedLayout === layoutKey && !allMeasured)) return;
    const visible = entries[index];
    const next = visible ? Math.max(0, measuredHeights.current.get(measureKey(visible)) ?? 0,
      visible.state === 'answered' ? openHeights.current.get(measureKey(visible)) ?? 0 : 0) : 0;
    const applied = bandHandling ? Math.max(next, heldHeight.current) : next;
    if (bandHandling) heldHeight.current = applied;
    setHeight(saved => saved === applied ? saved : applied);
    if (allMeasured && next > 0) { presentedSession.current = sessionId; setPresentedLayout(layoutKey); }
  };
  const latestMeasurement = useRef({ entries, commitHeight, measureKey });
  latestMeasurement.current = { entries, commitHeight, measureKey };
  useLayoutEffect(commitHeight, [entries, compact, width, bubble, index, handling]);
  const bubbleHeight = bubble ? Math.min(maxHeight ?? height, height || maxHeight || 0) : undefined;
  const inlineCapped = !bubble && (inlineExpanded || (inlineMaxHeight !== undefined && height > inlineMaxHeight));
  const inlineHeight = inlineCapped ? Math.min(inlineMaxHeight ?? height, height || inlineMaxHeight || 0) : undefined;
  // Keep a presented session interactive while its placement/width remeasures:
  // hiding the surface here also hides its focused native TextInput.
  const ready = verticalList || presentedLayout === layoutKey || (expandedKey !== null && presentedLayout !== null && presentedSession.current === sessionId)
    || (entries.length === 0 && Boolean(completion?.recent));
  useLayoutEffect(() => onReady?.(ready), [ready, onReady]);
  const interaction = (pressed: boolean) => { pressing.current = pressed; onInteraction?.(pressed); if (!pressed) commitHeight(); };
  const latestInteraction = useRef(interaction);
  latestInteraction.current = interaction;
  const navInteraction = useCallback((pressed: boolean) => latestInteraction.current(pressed), []);
  const scroll = useRef<ScrollView>(null);
  const verticalItemLayouts = useRef(new Map<string, { y: number; height: number }>());
  const verticalViewportHeight = useRef(0);
  const focusedVerticalKey = useRef<string | null>(null);
  const getVerticalTarget = useCallback(() => {
    const layout = focusedVerticalKey.current ? verticalItemLayouts.current.get(focusedVerticalKey.current) : undefined;
    return layout ? Math.max(0, layout.y + layout.height - verticalViewportHeight.current) : null;
  }, []);
  const verticalScroll = useReportComposerScroll(getVerticalTarget);
  const reveal = () => {
    const layout = verticalList && revealKey ? verticalItemLayouts.current.get(revealKey) : undefined;
    if (!layout) return;
    verticalScroll.scroll.current?.scrollTo({ y: layout.y, animated: false });
    onRevealed?.();
  };
  useEffect(reveal, [revealKey, verticalList]);
  const deck = useRef<View>(null);
  const titleNodes = useRef<Record<string, Text | null>>({});
  const expectedScroll = useRef<number | null>(null);
  const scrollOffset = useRef(0);
  const moveFocus = useRef(false);
  const count = entries.length;
  const key = entries[index]?.key;
  const keys = JSON.stringify(entries.map(entry => entry.key));
  const openLink = useOpenContentLink();
  const align = () => {
    if (verticalList || !width) return;
    expectedScroll.current = Math.abs(scrollOffset.current - index * width) > 1 ? index * width : null;
    scroll.current?.scrollTo({ x: index * width, animated: false });
  };
  useLayoutEffect(align, [width, keys, index, verticalList]);
  const page = `${index + 1} / ${count}`;
  const announced = useRef(key);
  useEffect(() => {
    if (announced.current === key) return;
    announced.current = key;
    if (key && Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility(!verticalList && count > 1 ? page : reportTag(entries[index]));
    if (!moveFocus.current) return;
    moveFocus.current = false;
    const target = key ? titleNodes.current[key] : null;
    if (!target) { onFocusComposer(); return; }
    if (Platform.OS === 'web') (target as unknown as HTMLElement).focus({ preventScroll: true });
    else { const handle = findNodeHandle(target); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); }
  }, [key, count, page, entries, index, onFocusComposer, verticalList]);
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
    const { cards } = await api.listCards(undefined, { includeCompleted: true });
    const card = cards.find(card => card.number === number);
    if (card) await openLink(`/?card=${encodeURIComponent(card.id)}`);
  }
  // RN 0.86 View exposes nativeEvent.key; RN web exposes key directly.
  const onKeyDown = (event: { key?: string; nativeEvent?: { key?: string }; target?: { tagName?: string; isContentEditable?: boolean }; preventDefault?(): void }) => {
    if ((renderCardDetails || onOpenCardDetails) && (event.target?.tagName === 'INPUT' || event.target?.tagName === 'TEXTAREA' || event.target?.isContentEditable)) return;
    const key = event.nativeEvent?.key ?? event.key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
    event.preventDefault?.(); step(key === 'ArrowRight' ? 1 : -1);
  };
  if (!count) {
    if (!completion?.recent || compact) return null;
    const undo = { label: completion.recent.label, expiresAt: completion.recent.expiresAt, busy: completion.busy, onUndo: () => {
      void completion.undo().then(ok => { if (!ok) setNotice('되돌리지 못했어.'); });
    } };
    return <View ref={deck} testID="report-deck" accessibilityLabel="지금의 보고" accessible={false}
      pointerEvents={ready ? 'auto' : 'none'} accessibilityElementsHidden={!ready} importantForAccessibility={ready ? 'auto' : 'no-hide-descendants'}
      style={[styles.deck, !bubble && styles.band, !ready && { opacity: 0 }]}
      {...reportWebProps({ role: 'region', 'aria-hidden': !ready })}>
      <View testID="report-footer" style={[styles.foot, { marginTop: 'auto' }]}><PersistentReportUndoRow undo={undo} styles={styles} /></View>
    </View>;
  }
  if (verticalList) {
    return <View ref={deck} testID="report-deck" accessibilityLabel="지금의 보고" accessible={false}
      pointerEvents={ready ? 'auto' : 'none'} accessibilityElementsHidden={!ready} importantForAccessibility={ready ? 'auto' : 'no-hide-descendants'}
      style={[{ flex: 1, minHeight: 0 }, !bubble && [styles.band, { marginBottom: 0 }], maxHeight !== undefined ? { maxHeight } : null, !ready && { opacity: 0 }]}
      {...reportWebProps({ role: 'region', 'aria-hidden': !ready })}
      onTouchStart={() => onDeckTouch?.(true)} onTouchEnd={() => onDeckTouch?.(false)} onTouchCancel={() => onDeckTouch?.(false)}>
      <ScrollView ref={verticalScroll.scroll} testID="report-track" showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled" style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ gap: t.cardLayout.gap, paddingBottom: t.uiSpacing.lg }}
        onScrollBeginDrag={() => interaction(true)} onScrollEndDrag={() => interaction(false)} onMomentumScrollEnd={() => interaction(false)}
        onLayout={event => { setWidth(event.nativeEvent.layout.width); verticalViewportHeight.current = event.nativeEvent.layout.height; verticalScroll.keepComposerVisible(); }}
        onContentSizeChange={verticalScroll.keepComposerVisible}>
        {entries.map((entry, i) => {
          const expandable = isPersistentReportCardExpandable(entry);
          const reviewCard = isReviewCardEntry(entry);
          const entryInteraction = (pressed: boolean) => {
            if (pressed && i !== index) onSelect(i);
            interaction(pressed);
          };
          const undo = i === index && completion?.recent ? { label: completion.recent.label, expiresAt: completion.recent.expiresAt,
            busy: completion.busy, onUndo: () => { void completion.undo().then(ok => { if (!ok) setNotice('되돌리지 못했어.'); }); } } : undefined;
          return <View key={JSON.stringify([sessionId, entry.key])} testID={`report-list-entry-${entry.key}`} onLayout={event => {
            const { y, height } = event.nativeEvent.layout;
            verticalItemLayouts.current.set(entry.key, { y, height });
            reveal();
            if (focusedVerticalKey.current === entry.key) verticalScroll.keepComposerVisible();
          }}><ReportComposerFocusContext.Provider value={focused => {
            focusedVerticalKey.current = focused ? entry.key : null;
            verticalScroll.onFocusChange(focused);
          }}><PersistentReportSheet entry={entry}
            question={renderQuestion?.(entry, { expanded: expandedKey === entry.key,
              expand: () => { if (onOpenCardDetails) onOpenCardDetails(entry); else setExpandedKey(entry.key); },
              detailView: detailQuestionView?.key === entry.key ? detailQuestionView.view : null })}
            expandedContent={expandable && expandedKey === entry.key
              ? renderCardDetails?.(entry, view => publishDetailQuestionView(entry.key, view)) : undefined}
            cardStatus={expandable ? renderCardStatus?.(entry) : undefined}
            onToggleCard={expandable && (renderCardDetails || onOpenCardDetails) ? () => {
              if (i !== index) onSelect(i);
              if (onOpenCardDetails) onOpenCardDetails(entry);
              else setExpandedKey(expandedKey === entry.key ? null : entry.key);
            } : undefined}
            index={i} count={count} current compact={false} showNav={false} width={width || undefined} styles={styles}
            cardSurface hidePageIndicator bubble={false} surfaceHeight={undefined}
            busy={reviewCard ? completion?.busy ?? true : isServerCardAcknowledgement(entry) ? false : send?.busy}
            canCancel={send?.canCancel(entry)} cancelSent={send?.cancelSent(entry)} acknowledgeLabel={reviewCard ? '완료' : undefined}
            holdAction={reviewCard ? { label: '보류', onPress: () => {
              if (!completion) return;
              void completion.complete(entry, entries, 'on_hold').then(ok => { if (!ok) setNotice('카드를 보류하지 못했어.'); });
            } } : undefined}
            undo={undo} onCancel={() => { if (i !== index) onSelect(i); void send?.cancel(entry); }} onInteraction={entryInteraction}
            onReady={() => {}} onHeight={() => {}} titleRef={node => { titleNodes.current[entry.key] = node; }} onStep={step} onExpand={expand}
            onDismiss={() => {
              if (i !== index) onSelect(i);
              if (reviewCard) {
                if (!completion) return;
                void completion.complete(entry).then(ok => { if (!ok) setNotice('카드를 완료하지 못했어.'); });
                return;
              }
              if (!send?.close(entry)) return;
              void onDismiss(entry.key).then(ok => { if (ok === false) setNotice('보고를 내리지 못했어.'); });
            }}
            onOption={option => { if (i !== index) onSelect(i); void send?.sendOption(entry, option); }}
            onCard={number => { if (i !== index) onSelect(i); void openCard(number); }}
            onLink={url => { if (i !== index) onSelect(i); void openLink(url); }} /></ReportComposerFocusContext.Provider></View>;
        })}
      </ScrollView>
    </View>;
  }
  const deckHeight = inlineMaxHeight !== undefined && height > 0 ? Math.min(height, inlineMaxHeight) : height;
  return <View ref={deck} testID="report-deck" accessibilityLabel="지금의 보고" accessible={false}
    pointerEvents={ready ? 'auto' : 'none'} accessibilityElementsHidden={!ready} importantForAccessibility={ready ? 'auto' : 'no-hide-descendants'}
    style={[styles.deck, !bubble && styles.band, bubble && { height: bubbleHeight, maxHeight },
      !bubble && { maxHeight: inlineMaxHeight, overflow: 'hidden' },
      inlineCapped && { height: inlineHeight, maxHeight: inlineMaxHeight }, !ready && { opacity: 0 }]} {...reportWebProps({ role: 'region', 'aria-hidden': !ready })}
    onTouchStart={() => onDeckTouch?.(true)} onTouchEnd={() => onDeckTouch?.(false)} onTouchCancel={() => onDeckTouch?.(false)}
    {...{ onKeyDown }}>
    <ScrollView ref={scroll} testID="report-track" horizontal pagingEnabled showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.track, inlineCapped && { height: inlineHeight }]} style={bubble ? { height: bubbleHeight, flexShrink: 0,
        // The surface's existing horizontal borders belong to its height;
        // let the viewport span them without adding two more pixels.
        marginVertical: -StyleSheet.hairlineWidth } : inlineCapped ? { height: inlineHeight, flexShrink: 0 }
          : deckHeight ? { height: deckHeight } : undefined}
      onScrollBeginDrag={() => { sliding.current = true; interaction(true); }}
      onScrollEndDrag={event => {
        const { contentOffset } = event.nativeEvent;
        if (width <= 0 || Math.abs(contentOffset.x - Math.round(contentOffset.x / width) * width) <= 1) sliding.current = false;
        interaction(false);
      }}
      onMomentumScrollEnd={() => { sliding.current = false; interaction(false); }}
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
      {width > 0 ? entries.map((entry, i) => {
        const expandable = isPersistentReportCardExpandable(entry);
        const reviewCard = isReviewCardEntry(entry);
        const undo = i === index && completion?.recent ? { label: completion.recent.label, expiresAt: completion.recent.expiresAt,
          busy: completion.busy, onUndo: () => {
          void completion.undo().then(ok => { if (!ok) setNotice('되돌리지 못했어.'); });
        } } : undefined;
        return <PersistentReportSheet key={JSON.stringify([sessionId, entry.key])} entry={entry}
        question={renderQuestion?.(entry, { expanded: expandedKey === entry.key,
          expand: () => { if (onOpenCardDetails) onOpenCardDetails(entry); else setExpandedKey(entry.key); },
          detailView: detailQuestionView?.key === entry.key ? detailQuestionView.view : null })}
        expandedContent={expandable && expandedKey === entry.key
          ? renderCardDetails?.(entry, view => publishDetailQuestionView(entry.key, view)) : undefined}
        cardStatus={expandable ? renderCardStatus?.(entry) : undefined}
        onToggleCard={expandable && (renderCardDetails || onOpenCardDetails) ? () => {
          if (onOpenCardDetails) onOpenCardDetails(entry);
          else setExpandedKey(expandedKey === entry.key ? null : entry.key);
        } : undefined}
        index={i} count={count} current={i === index} compact={compact} showNav={!phone} width={width} styles={styles}
        bubble={bubble} surfaceHeight={bubble ? bubbleHeight : inlineHeight}
        busy={reviewCard ? completion?.busy ?? true : isServerCardAcknowledgement(entry) ? false : send?.busy} canCancel={send?.canCancel(entry)} cancelSent={send?.cancelSent(entry)}
        acknowledgeLabel={reviewCard ? '완료' : undefined} undo={undo}
        holdAction={reviewCard ? { label: '보류', onPress: () => {
          if (!completion) return;
          void completion.complete(entry, entries, 'on_hold').then(ok => { if (!ok) setNotice('카드를 보류하지 못했어.'); });
        } } : undefined}
        onCancel={() => void send?.cancel(entry)} onInteraction={interaction}
        onReady={() => {
          const id = measureKey(entry), latest = latestMeasurement.current;
          if (!latest.entries.some(saved => latest.measureKey(saved) === id)) return;
          readyHeights.current.add(id); latest.commitHeight();
        }}
        onHeight={height => {
          const id = measureKey(entry), latest = latestMeasurement.current;
          const currentEntry = latest.entries.find(saved => latest.measureKey(saved) === id);
          if (!currentEntry) return; // A removed/replaced sheet cannot restore an old height.
          measuredHeights.current.set(id, height);
          if (currentEntry.state === 'open' && !undo) openHeights.current.set(id, height);
          latest.commitHeight();
        }}
        titleRef={node => { titleNodes.current[entry.key] = node; }} onStep={step} onExpand={expand}
        onDismiss={() => {
          if (reviewCard) {
            if (!completion) return;
            moveFocus.current = Platform.OS !== 'web' || focusInside();
            void completion.complete(entry).then(ok => { if (!ok) setNotice('카드를 완료하지 못했어.'); });
            return;
          }
          if (!send?.close(entry)) return;
          moveFocus.current = Platform.OS !== 'web' || focusInside();
          void onDismiss(entry.key).then(ok => { if (ok === false) setNotice('보고를 내리지 못했어.'); });
        }}
        onOption={option => {
          void send?.sendOption(entry, option);
        }} onCard={number => void openCard(number)} onLink={url => void openLink(url)} />
      }) : null}
    </ScrollView>
    {count > 1 && !compact && !phone ? <View testID="report-nav" style={[styles.nav, completion?.recent
      ? { bottom: t.uiSpacing.lg + t.hitTarget.min + t.uiSpacing.sm } : null]}>
      <ReportNavButton interaction={navInteraction} testID="report-prev-touch" iconOnly variant="plain" size="compact" accessibilityLabel="앞 장" disabled={index === 0} onPress={() => step(-1)}>
        <Ionicons name="chevron-back" size={t.iconSize.navigation} color={index === 0 ? t.colors.textPlaceholder : t.colors.textPrimary} />
      </ReportNavButton>
      <Text testID={phone ? 'report-page' : 'report-count'} aria-live="polite" style={styles.count}
        accessible accessibilityRole="adjustable" accessibilityLabel="지금의 보고"
        accessibilityValue={{ min: 1, max: count, now: index + 1, text: page }}
        accessibilityActions={[{ name: 'increment', label: '다음 장' }, { name: 'decrement', label: '앞 장' }]}
        onAccessibilityAction={event => step(event.nativeEvent.actionName === 'increment' ? 1 : -1)}>{page}</Text>
      <ReportNavButton interaction={navInteraction} testID="report-next-touch" iconOnly variant="plain" size="compact" accessibilityLabel="다음 장" disabled={index === count - 1} onPress={() => step(1)}>
        <Ionicons name="chevron-forward" size={t.iconSize.navigation} color={index === count - 1 ? t.colors.textPlaceholder : t.colors.textPrimary} />
      </ReportNavButton>
    </View> : null}
  </View>;
}

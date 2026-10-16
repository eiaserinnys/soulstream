import React, { useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { PersistentReportEntry } from '../../api/types';
import { reportActionParts } from '../../lib/persistent-report';
import { useTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { PersistentReportReading } from './PersistentReportReading';
import type { reportStyles } from './persistentReportStyles';

export const reportWebProps = (props: Record<string, unknown>) => Platform.OS === 'web' ? props : {};
export function reportTag(entry: PersistentReportEntry) {
  return entry.kind === 'see' ? '보실 것' : entry.state === 'answered' ? '답 받음' : '답하실 것';
}
export function PersistentReportSheet({ entry, index, count, current, compact, showNav, width, styles,
  titleRef, onStep, onExpand, onOption, onDismiss, onCard, onLink, bubble = false, bubbleHeight, busy = false,
  canCancel = false, cancelSent = false, onCancel, onHeight, onInteraction, onReady }: {
  entry: PersistentReportEntry; index: number; count: number; current: boolean; compact: boolean; showNav: boolean; width: number;
  styles: ReturnType<typeof reportStyles>; titleRef(node: Text | null): void;
  onStep(by: number): void; onExpand(): void; onOption(option: string): void; onDismiss(): void;
  onCard(number: number): void; onLink(url: string): void;
  bubble?: boolean; bubbleHeight?: number; busy?: boolean; canCancel?: boolean; cancelSent?: boolean; onCancel?(): void;
  onHeight?(height: number): void; onInteraction?(pressed: boolean): void;
  onReady?(): void;
}) {
  const t = useTokens();
  const signature = JSON.stringify([entry.title, entry.context, entry.action, entry.options, entry.card_numbers, compact]);
  const [asked, setAsked] = useState({ signature, reading: 0, foot: 0 });
  if (asked.signature !== signature) setAsked({ signature, reading: 0, foot: 0 });
  const acknowledgeable = entry.kind === 'see' || (entry.kind === 'ask' && entry.options.length === 0 && entry.state === 'open');
  const hasFooter = !compact && (count > 1 || entry.state === 'answered' || acknowledgeable || entry.options.length > 0);
  const measured = useRef<{ reading: number | null; foot: number | null }>({ reading: null, foot: null });
  const measure = (part: 'reading' | 'foot', height: number) => {
    measured.current[part] = height;
    // Content size already includes reading padding; footer layout includes
    // its padding. Only bubbles wait for both parts; bands report each measurement.
    if (!bubble || (measured.current.reading !== null && (!hasFooter || measured.current.foot !== null))) {
      onHeight?.((measured.current.reading ?? 0) + (hasFooter || !bubble ? measured.current.foot ?? 0 : 0));
    }
    if (measured.current.reading !== null && (!hasFooter || measured.current.foot !== null)) onReady?.();
    if (entry.state === 'open') setAsked(saved => saved[part] === height ? saved : { ...saved, [part]: height });
  };
  const answer = entry.kind === 'ask' && entry.state === 'answered';
  const page = `${index + 1} / ${count}`;
  const received = <Text testID="report-received" style={styles.todo}><Text style={styles.receivedLabel}>받은 답  </Text>{entry.answer}</Text>;
  const heading = <View testID="report-head" style={styles.heading}>
    <Text ref={titleRef} testID="report-title" accessible accessibilityRole="header" style={styles.title}
      {...reportWebProps({ tabIndex: -1 })}
      {...(compact ? { onPress: (event: { stopPropagation(): void }) => { event.stopPropagation(); onExpand(); }, accessibilityHint: '누르면 펼칩니다',
        accessibilityActions: [{ name: 'expand', label: '펼치기' }], onAccessibilityAction: onExpand } : {})}>{entry.title}</Text>
    {entry.card_numbers.map(number => <View key={number} style={styles.chipSlot}>
      <CompactTouchTarget testID="report-card-link" surfaceTestID="report-card-pill" accessibilityRole="link"
        accessibilityLabel={`카드 ${number}번 열기`} frameStyle={styles.chipFrame} surfaceStyle={styles.chipSurface}
        onPressIn={() => onInteraction?.(true)} onPressOut={() => onInteraction?.(false)}
        onPress={event => { event.stopPropagation(); onCard(number); }}>
        <View style={styles.chipContents}><Ionicons name="open-outline" size={t.foundation.typography.meta.fontSize} color={t.colors.link} />
          <Text testID="report-card-number" style={styles.cardNumber}>#{number}</Text></View>
      </CompactTouchTarget>
    </View>)}
  </View>;
  const todo = <Text testID="report-todo" numberOfLines={compact ? 2 : undefined} style={styles.todo}>
    {reportActionParts(entry.action).map((part, i) => typeof part === 'string' ? part : <Text key={i} testID="report-link"
      accessibilityRole="link" style={styles.link} onPress={event => { event.stopPropagation(); onLink(part.url); }}>{part.label}</Text>)}
  </Text>;
  const frame = <View testID="report-reading"
    onLayout={!bubble ? event => measure('reading', event.nativeEvent.layout.height + t.uiSpacing.md
      + (compact ? t.uiSpacing.lg + (count > 1 ? t.uiSpacing.sm + t.foundation.typography.meta.lineHeight : 0) : 0)) : undefined}
    style={[styles.reading, answer && !bubble && !compact && asked.reading ? { minHeight: Math.max(0, asked.reading - t.uiSpacing.md) } : null]}>
    {heading}{!compact ? <Text testID="report-context" style={styles.context}>{entry.context}</Text> : null}
    {answer ? compact ? received : null : todo}
  </View>;
  const foot = hasFooter
    ? <View testID="report-footer" style={styles.foot} onLayout={event => measure('foot', event.nativeEvent.layout.height)}>
      {count > 1 ? <View testID="report-nav-slot" style={[styles.navSlot, !showNav && { width: 'auto', minWidth: t.uiSpacing.xxl,
        height: t.hitTarget.min, justifyContent: 'center' }]}
>
        {!showNav ? <Text testID="report-page" style={styles.count} numberOfLines={1}
          accessible accessibilityRole="adjustable" accessibilityLabel="지금의 보고"
          accessibilityValue={{ min: 1, max: count, now: index + 1, text: page }}
          accessibilityActions={[{ name: 'increment', label: '다음 장' }, { name: 'decrement', label: '앞 장' }]}
          onAccessibilityAction={event => onStep(event.nativeEvent.actionName === 'increment' ? 1 : -1)}>{page}</Text> : null}
      </View> : null}
      {answer ? <View testID="report-received-row" style={[styles.received, { minHeight: t.hitTarget.min }]}>
        {received}{cancelSent ? <View style={styles.cancelStatus}><Text testID="report-cancel-sent" style={styles.cancelLabel}>취소 요청 보냄</Text></View>
          : canCancel ? <View style={styles.cancelEdge}><GlassButton testID="report-cancel" variant="plain" size="compact"
            disabled={busy} accessibilityLabel="취소 요청" onPress={() => onCancel?.()}><Text style={styles.cancelLabel}>취소 요청</Text></GlassButton></View> : null}
      </View> : acknowledgeable || entry.options.length ? <View testID="report-actions" style={styles.actions}>
        {(acknowledgeable ? ['확인했어'] : entry.options).map(option => <GlassButton key={option} variant="paper" size="compact"
          disabled={busy} accessibilityLabel={option}
          onPress={() => acknowledgeable ? onDismiss() : onOption(option)} style={styles.button}>
          <Text style={styles.buttonLabel}>{option}</Text>
        </GlassButton>)}
      </View> : null}
    </View> : null;
  return <Pressable testID={`report-sheet-${entry.key}`} accessible={false}
    aria-hidden={!current} accessibilityElementsHidden={!current} importantForAccessibility={current ? 'auto' : 'no-hide-descendants'}
    accessibilityLabel={`${count > 1 ? `${page}, ` : ''}${reportTag(entry)}, ${entry.title}`}
    onPress={compact ? onExpand : undefined} onTouchStart={() => onInteraction?.(true)} onTouchEnd={() => onInteraction?.(false)}
    onTouchCancel={() => onInteraction?.(false)} {...reportWebProps({ inert: !current, tabIndex: -1, role: 'group' })}
    style={[styles.sheet, { width, minWidth: t.hitTarget.min, minHeight: t.hitTarget.min }, bubble && { height: bubbleHeight }, !compact && styles.resting]}>
    {bubble ? <PersistentReportReading current={current} styles={styles} onHeight={height => measure('reading', height)}>{frame}</PersistentReportReading>
      : <View style={[styles.body, compact ? styles.compact : null, { flexGrow: 1 }]}>{frame}
        {compact && count > 1 ? <Text testID="report-page" style={styles.page} accessible accessibilityRole="adjustable" accessibilityLabel="지금의 보고"
          accessibilityValue={{ min: 1, max: count, now: index + 1, text: page }}
          accessibilityActions={[{ name: 'increment', label: '다음 장' }, { name: 'decrement', label: '앞 장' }]}
          onAccessibilityAction={event => onStep(event.nativeEvent.actionName === 'increment' ? 1 : -1)}>{page}</Text> : null}
      </View>}
    {foot}
  </Pressable>;
}

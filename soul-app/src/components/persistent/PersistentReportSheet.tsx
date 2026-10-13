import React, { useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import type { PersistentReportEntry } from '../../api/types';
import { reportActionParts } from '../../lib/persistent-report';
import { useTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import type { reportStyles } from './persistentReportStyles';

export const reportWebProps = (props: Record<string, unknown>) => Platform.OS === 'web' ? props : {};
export function reportTag(entry: PersistentReportEntry) {
  return entry.kind === 'see' ? '보실 것' : entry.state === 'answered' ? '답 받음' : '답하실 것';
}
export function PersistentReportSheet({ entry, index, count, current, compact, showNav, width, styles,
  nodeRef, onStep, onExpand, onOption, onDismiss, onCard, onLink }: {
  entry: PersistentReportEntry; index: number; count: number; current: boolean; compact: boolean; showNav: boolean; width: number;
  styles: ReturnType<typeof reportStyles>; nodeRef(node: View | null): void;
  onStep(by: number): void; onExpand(): void; onOption(option: string): void; onDismiss(): void;
  onCard(number: number): void; onLink(url: string): void;
}) {
  const t = useTokens();
  const mode = compact ? 'compact' : 'full';
  // Remember intrinsic contents, not the height stretched by another sheet.
  const signature = JSON.stringify([entry.title, entry.context, entry.action, entry.options]);
  const empty = () => ({ signature, full: { reading: 0, actions: 0 }, compact: { reading: 0, actions: 0 } });
  const [asked, setAsked] = useState(empty);
  if (asked.signature !== signature) setAsked(empty());
  const measure = (part: 'reading' | 'actions', height: number) => {
    if (entry.state !== 'open') return;
    setAsked(saved => saved[mode][part] === height ? saved : { ...saved, [mode]: { ...saved[mode], [part]: height } });
  };
  const sizes = asked[mode];
  const beforeAnswer = sizes.reading + sizes.actions + t.uiSpacing.md + t.uiSpacing.lg
    + (sizes.actions ? t.uiSpacing.md : 0);
  const page = `${index + 1} / ${count}`;
  const tag = reportTag(entry);
  const received = <Text testID="report-received" style={styles.todo}><Text style={styles.receivedLabel}>받은 답  </Text>{entry.answer}</Text>;
  const answer = entry.kind === 'ask' && entry.state === 'answered';
  return <Pressable testID={`report-sheet-${entry.key}`} ref={nodeRef} accessible={false}
    aria-hidden={!current} accessibilityElementsHidden={!current} importantForAccessibility={current ? 'auto' : 'no-hide-descendants'}
    accessibilityLabel={`${count > 1 ? `${page}, ` : ''}${tag}, ${entry.title}`}
    onPress={compact ? onExpand : undefined} {...reportWebProps({ inert: !current, tabIndex: -1, role: 'group' })}
    style={[styles.sheet, { width }, answer && sizes.reading ? { minHeight: beforeAnswer } : null, !compact && styles.resting]}>
    <View style={styles.reading} onLayout={event => measure('reading', event.nativeEvent.layout.height)}>
      <View style={styles.heading}>
        <View style={[styles.tagRow, count > 1 && showNav && styles.tagRowWithNav]}>
          <Text testID="report-kind" style={[styles.kind, entry.kind === 'ask' && !answer ? styles.kindAsk : styles.kindQuiet]}>{tag}</Text>
          {entry.card_numbers.map(number => <Text key={number} testID="report-card-number" accessibilityRole="link"
            accessibilityLabel={`카드 ${number}번 열기`} onPress={event => { event.stopPropagation(); onCard(number); }} style={styles.cardNumber}>#{number}</Text>)}
          {count > 1 && !showNav ? <Text testID="report-page" accessible accessibilityRole="adjustable" accessibilityLabel="지금의 보고"
            accessibilityValue={{ min: 1, max: count, now: index + 1, text: page }}
            accessibilityActions={[{ name: 'increment', label: '다음 장' }, { name: 'decrement', label: '앞 장' }]}
            onAccessibilityAction={event => onStep(event.nativeEvent.actionName === 'increment' ? 1 : -1)}
            {...reportWebProps({ 'aria-valuemin': 1, 'aria-valuemax': count, 'aria-valuenow': index + 1, 'aria-valuetext': page, tabIndex: 0 })}
            style={styles.page}>{page}</Text> : null}
        </View>
        <Text testID="report-title" accessibilityRole="header" style={styles.title}
          {...(compact ? { onPress: (event: { stopPropagation(): void }) => { event.stopPropagation(); onExpand(); }, accessibilityHint: '누르면 펼칩니다', accessibilityState: { expanded: false },
            accessibilityActions: [{ name: 'expand', label: '펼치기' }], onAccessibilityAction: onExpand,
            ...reportWebProps({ 'aria-label': `${entry.title}, 누르면 펼칩니다` }) } : {})}>{entry.title}</Text>
      </View>
      {!compact ? <Text testID="report-context" style={styles.context}>{entry.context}</Text> : null}
      {!answer ? <Text testID="report-todo" numberOfLines={compact ? 2 : undefined} style={styles.todo}>
        {reportActionParts(entry.action).map((part, i) => typeof part === 'string' ? part : <Text key={i} testID="report-link"
          accessibilityRole="link" style={styles.link} onPress={event => { event.stopPropagation(); onLink(part.url); }}>{part.label}</Text>)}
      </Text> : compact ? received : null}
    </View>
    {!compact ? answer ? received : entry.kind === 'see' || entry.options.length ? <View testID="report-actions" style={styles.actions}
      onLayout={event => measure('actions', event.nativeEvent.layout.height)}>
      {(entry.kind === 'see' ? ['봤다'] : entry.options).map(option => <GlassButton key={option} variant="paper" size="compact"
        accessibilityLabel={option} onPress={() => entry.kind === 'see' ? onDismiss() : onOption(option)} style={styles.button}>
        <Text style={styles.buttonLabel}>{option}</Text>
      </GlassButton>)}
    </View> : null : null}
  </Pressable>;
}

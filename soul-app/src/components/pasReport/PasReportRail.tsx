// 카드 #1871: 보고 창의 안건 목록. 820pt 이상은 왼쪽 고정 레일, 그 아래는 머리줄 「안건 목록」 단추로 여는 서랍이 같은 행을 쓴다.
import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CardDto } from '../../api/cardTypes';
import { AGENDA_KIND_LABEL } from '../../../../packages/soul-ui/src/lib/pas-report-thread-core';
import { formatReturnTime, type Agenda } from '../../lib/pas-report-thread-model';
import { useTokens, type DesignTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { CardStatusChip } from '../planner/CardRow';
import type { PasReportWindowController } from './usePasReportWindow';

/** 안건 종류 칩은 카드 상태 칩(CardStatusChip)을 그대로 쓴다. 질문과 부탁은 막힘 중 질문 칩이다. */
export function agendaChipCard(agenda: Agenda): CardDto {
  const status = agenda.kind === 'review' ? 'review' : agenda.kind === 'running' ? 'running'
    : agenda.kind === 'verifying' ? 'awaiting_verification' : 'blocked';
  return { id: `pas-report-chip-${agenda.cardId}`, status, blockedKind: agenda.kind === 'question' || agenda.kind === 'request' ? 'question' : null } as CardDto;
}

type Section = { title: string; items: Array<{ agenda: Agenda; note: string | null }>; always: boolean };

export function PasReportRail({ controller, onSelect }: { controller: PasReportWindowController; onSelect(cardId: string): void }) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const { groups, processed, activeCardId, now, cardsError } = controller;
  // 카드 목록을 못 읽었으면 진행 중과 보류함은 0이 아니라 알 수 없는 것이다.
  const unknown = Boolean(cardsError);
  const sections: Section[] = [
    { title: '결재 대기', items: groups.pending.map(agenda => ({ agenda, note: null })), always: true },
    { title: '진행 중', items: groups.running.map(agenda => ({ agenda, note: null })), always: true },
    { title: '미뤄 둠', items: groups.snoozed.map(agenda => ({ agenda, note: formatReturnTime(agenda.snoozedUntil!, now) })), always: false },
    { title: '처리됨', items: processed.map(item => ({ agenda: item.agenda, note: item.label })), always: false },
  ];
  return <View testID="pas-report-rail" accessibilityLabel="안건 목록" style={styles.rail}>
    <ScrollView style={styles.sections} contentContainerStyle={styles.sectionsContent} showsVerticalScrollIndicator={false}>
      {sections.filter(section => section.items.length || section.always).map(section => <View key={section.title} testID={`pas-report-rail-${section.title}`}>
        <View style={styles.head}>
          <Text accessibilityRole="header" style={styles.headTitle}>{section.title}</Text>
          <Text style={styles.count}>{unknown && section.title === '진행 중' ? '–' : section.items.length}</Text>
        </View>
        <View style={styles.list}>
          {section.items.map(({ agenda, note }) => {
            const active = agenda.cardId === activeCardId;
            const kind = AGENDA_KIND_LABEL[agenda.kind];
            return <Pressable key={agenda.cardId} testID={`pas-report-row-${agenda.cardId}`} accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${agenda.number === null ? '' : `${agenda.number}번 `}${agenda.title}, ${kind}${note ? `, ${note}` : ''}`}
              onPress={() => onSelect(agenda.cardId)} style={[styles.row, active && styles.rowActive]}>
              {active ? <View testID="pas-report-row-bar" style={styles.bar} /> : null}
              <View style={styles.meta}>
                {agenda.number === null ? null : <Text style={styles.number}>#{agenda.number}</Text>}
                <CardStatusChip card={agendaChipCard(agenda)} detail label={kind} />
                {note ? <Text style={styles.note} numberOfLines={1}>{note}</Text> : null}
              </View>
              <Text style={styles.title} numberOfLines={3}>{agenda.title}</Text>
            </Pressable>;
          })}
        </View>
      </View>)}
    </ScrollView>
    <View style={styles.foot}>
      {unknown ? <View testID="pas-report-rail-error" accessibilityRole="alert" style={styles.error}>
        <Text style={styles.errorText}>카드 목록을 불러오지 못해 진행 중과 보류함을 알 수 없어.</Text>
        <GlassButton size="compact" variant="paper" accessibilityLabel="카드 목록 다시 시도" onPress={controller.retryCards}>
          <Text style={styles.retry}>다시 시도</Text>
        </GlassButton>
      </View> : <Text testID="pas-report-rail-hold" style={styles.footText}>보류함 {groups.holdCount}개</Text>}
    </View>
  </View>;
}

function makeStyles(t: DesignTokens) {
  const type = t.foundation.typography;
  // 강조 막대(xs) 뒤 순수 여백 md. 구역 머리도 같은 시작선에 선다(#1707에서 바로잡은 것).
  const textInset = t.uiSpacing.xs + t.uiSpacing.md;
  return StyleSheet.create({
    rail: { flex: 1, minHeight: 0, paddingTop: t.uiSpacing.md, paddingBottom: t.uiSpacing.lg, paddingHorizontal: t.uiSpacing.md },
    sections: { flex: 1, minHeight: 0 },
    sectionsContent: { gap: t.uiSpacing.xl },
    head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.uiSpacing.sm,
      paddingLeft: textInset + StyleSheet.hairlineWidth, paddingRight: t.uiSpacing.md, paddingBottom: t.uiSpacing.sm },
    headTitle: { ...type.body, color: t.colors.textPrimary },
    count: { ...type.meta, color: t.colors.textSecondary, fontVariant: ['tabular-nums'], minWidth: t.uiSpacing.xl, textAlign: 'center',
      backgroundColor: t.colors.surfaceCode, borderRadius: t.foundation.radius.capsule, paddingHorizontal: t.uiSpacing.sm, overflow: 'hidden' },
    list: { gap: t.uiSpacing.xs },
    row: { alignSelf: 'stretch', minHeight: t.hitTarget.min, borderRadius: t.radius.floor, borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent', overflow: 'hidden',
      paddingVertical: t.uiSpacing.md, paddingRight: t.uiSpacing.md, paddingLeft: textInset, gap: t.uiSpacing.xs },
    rowActive: { borderColor: t.persistentSession.line, backgroundColor: t.persistentSession.panel },
    bar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: t.uiSpacing.xs, backgroundColor: t.colors.accent },
    meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: t.uiSpacing.sm, rowGap: t.uiSpacing.xs },
    number: { ...type.meta, color: t.colors.accent, fontVariant: ['tabular-nums'] },
    note: { ...type.meta, color: t.colors.textSecondary, flexShrink: 1 },
    title: { ...type.body, color: t.colors.textPrimary },
    foot: { paddingTop: t.uiSpacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.persistentSession.line },
    errorText: { ...type.meta, color: t.colors.textSecondary },
    footText: { ...type.meta, color: t.colors.textSecondary, paddingHorizontal: textInset },
    error: { gap: t.uiSpacing.sm, alignItems: 'flex-start', paddingHorizontal: textInset },
    retry: { ...type.body, color: t.colors.textPrimary },
  });
}

import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { CardCheckItem, CardItemDisplay } from '../../api/cardTypes';
import { formatCardTime } from '../../lib/card-check-item-summary';
import { cardImageSource } from '../../lib/card-image-source';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { AttachmentImage } from '../AttachmentImage';
import { CardItemCheckbox } from '../CardItemCheckbox';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { StatusPulseDecorationLayer, withAlphaColor } from '../StatusPulseDecoration';
import { STATUS_DOT_SIZE } from '../chat/StatusDot';

const DISPLAY_LABELS: Record<CardItemDisplay, string> = {
  todo: '아직',
  doing: '하는 중',
  reported: '됐다고 보고',
  changed: '다시 봐 주세요',
  fix: '고칠 점',
  confirmed: '확인함',
  dropped: '뺌',
};

function statusColor(item: CardCheckItem, t: ReturnType<typeof useTokens>): string | null {
  switch (item.display) {
    case 'doing': return t.colors.statusRunning;
    case 'reported': return t.colors.statusCompleted;
    case 'changed': return t.mode === 'dark' ? t.colors.warning : t.colors.warningText;
    case 'confirmed': return t.colors.statusCompleted;
    case 'fix': return t.colors.statusError;
    default: return null;
  }
}

export function CardCheckItemRow({
  item,
  checked,
  pending,
  expanded,
  paneWidth,
  onToggle,
  onConfirm,
  onSetTarget,
}: {
  item: CardCheckItem;
  checked: boolean;
  pending: boolean;
  expanded: boolean;
  paneWidth: number;
  onToggle(): void;
  onConfirm(confirmed: boolean): void;
  onSetTarget(item: CardCheckItem): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const jwt = useAuthStore((state) => state.jwt);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const [rowWidth, setRowWidth] = useState(0);
  const images = item.evidence.filter((evidence) => evidence.type === 'image');
  const links = item.evidence.filter((evidence) => evidence.type === 'link');
  const imageSources = images.map((evidence) => cardImageSource(evidence.url, serverUrl, jwt));
  const running = item.display === 'doing';
  const color = statusColor(item, t);
  const rowColor = item.display === 'confirmed' ? null : item.display === 'changed' ? t.colors.warning : color;
  const metadata = [item.reportedAt ? formatCardTime(item.reportedAt) : '', item.from ? `${formatCardTime(item.from.at)} ${item.from.kind === 'spoken' ? '대화에서 추가' : '커멘트에서 추가'}`.trim() : ''].filter(Boolean).join(', ');
  const rowExpanded = expanded || item.display === 'dropped';

  return (
    <View
      testID={`card-check-item-${item.id}`}
      style={[
        styles.row,
        rowColor ? { backgroundColor: withAlphaColor(rowColor, 0.12) } : null,
      ]}
      onLayout={(event) => {
        const nextWidth = event.nativeEvent.layout.width;
        setRowWidth((previous) => previous === nextWidth ? previous : nextWidth);
      }}
    >
      {running ? (
        <StatusPulseDecorationLayer
          testID={`card-check-item-${item.id}-shimmer`}
          cardWidth={rowWidth}
          color={t.colors.statusRunning}
          borderRadius={t.foundation.radius.field}
        />
      ) : null}
      <View style={styles.mainRow}>
        <CardItemCheckbox
          itemId={item.id}
          title={item.title}
          checked={checked}
          disabled={item.display === 'dropped' || pending}
          onPress={() => {
            if (item.display === 'dropped' || pending) return;
            onConfirm(!checked);
          }}
        />
        <CompactTouchTarget
          testID={`card-check-item-${item.id}-expand`}
          surfaceTestID={`card-check-item-${item.id}-title-visual`}
          accessibilityRole="button"
          accessibilityLabel={`${item.id} ${item.title} ${rowExpanded ? '접기' : '펼치기'}`}
          accessibilityState={{ expanded: rowExpanded }}
          disabled={item.display === 'dropped'}
          frameStyle={styles.titleHitFrame}
          surfaceStyle={styles.titleHitSurface}
          onPress={() => {
            onToggle();
          }}
        >
          <View testID={`card-check-item-${item.id}-title-row`} style={[styles.titleRow, paneWidth < 400 ? styles.titleStacked : null]}>
            <Text style={[styles.number, checked && styles.confirmedNumber]}>{item.id}</Text>
            <Text
              testID={`card-check-item-${item.id}-title`}
              numberOfLines={3}
              style={[
                styles.title,
                item.display === 'todo' || checked ? styles.dimTitle : null,
                item.display === 'dropped' ? styles.droppedTitle : null,
              ]}
            >
              {item.title}
            </Text>
            <View testID={`card-check-item-${item.id}-status`} style={[styles.status, paneWidth < 400 ? styles.statusBelow : null]}>
              {running ? <View style={styles.runningDot} /> : null}
              <Text style={[styles.statusText, color ? { color } : null]}>
                {item.display === 'fix' ? `${DISPLAY_LABELS.fix} ${item.fixOpen}` : DISPLAY_LABELS[item.display]}
              </Text>
            </View>
          </View>
        </CompactTouchTarget>
      </View>

      {rowExpanded ? (
        <View style={styles.details}>
          {item.display === 'changed' && item.reopened ? (
            <View style={styles.changedReason}><Text style={styles.reopened}>확인한 뒤 바뀜</Text><Text style={styles.result} testID={`card-check-item-${item.id}-reopened`}>{item.reopened}</Text></View>
          ) : null}
          {item.result ? <Text style={[styles.result, item.display === 'dropped' && styles.droppedResult]}>{item.result}</Text> : null}
          {item.evidence.length ? (
            <View style={styles.evidence}>
              {images.length ? <View testID={`card-check-item-${item.id}-evidence-images`} style={styles.evidenceImages}>
                {images.map((evidence, index) => (
                  <View key={`${item.id}-${evidence.url}`} style={styles.imageEvidence}>
                    <AttachmentImage
                      testID={`card-check-item-${item.id}-evidence-${index}`}
                      accessibilityLabel={evidence.label || `항목 ${item.id} 증거 ${index + 1}`}
                      source={imageSources[index]}
                      sources={imageSources}
                      index={index}
                      variant="cardCheckItem"
                    />
                    {evidence.label ? <Text style={styles.evidenceLabel}>{evidence.label}</Text> : null}
                  </View>
                ))}
              </View> : null}
              {links.length ? <View testID={`card-check-item-${item.id}-evidence-links`} style={styles.evidenceLinks}>
                {links.map((evidence) => (
                  <CompactTouchTarget
                    key={`${item.id}-${evidence.url}`}
                    testID={`card-check-item-${item.id}-link`}
                    accessibilityRole="link"
                    accessibilityLabel={evidence.label || evidence.url}
                    frameStyle={styles.linkFrame}
                    surfaceStyle={styles.linkSurface}
                    onPress={() => { void WebBrowser.openBrowserAsync(evidence.url); }}
                  >
                    <View style={styles.linkContent}>
                      <Ionicons testID={`card-check-item-${item.id}-link-icon`} name="open-outline" size={t.foundation.typography.meta.fontSize} color={t.colors.link} />
                      <Text numberOfLines={1} style={styles.linkText}>{evidence.label || evidence.url}</Text>
                    </View>
                  </CompactTouchTarget>
                ))}
              </View> : null}
            </View>
          ) : null}
          <View style={styles.footer}>
            {item.caveat ? <View style={styles.caveatRow}>
              <Ionicons testID={`card-check-item-${item.id}-caveat-icon`} name="warning-outline" size={t.foundation.typography.meta.fontSize} color={t.colors.warningText} />
              <Text style={styles.caveat} testID={`card-check-item-${item.id}-caveat`}>{item.caveat}</Text>
            </View> : null}
            {item.display !== 'dropped' ? <CompactTouchTarget
              testID={`card-check-item-${item.id}-fix`}
              accessibilityLabel={`${item.id} ${item.title} 고칠 점 남기기`}
              frameStyle={styles.fixFrame} surfaceStyle={styles.fixSurface}
              onPress={() => onSetTarget(item)}>
              <Text style={styles.fixText}>고칠 점 남기기</Text>
            </CompactTouchTarget> : null}
          </View>
          {metadata ? <Text style={styles.source}>{metadata}</Text> : null}
        </View>
      ) : null}
      {pending ? <Text accessibilityRole="text" style={styles.pending}>저장 중</Text> : null}
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    row: {
      position: 'relative',
      overflow: 'hidden',
      borderRadius: t.foundation.radius.field,
      marginBottom: t.uiSpacing.xxs,
      paddingVertical: t.uiSpacing.xs,
      paddingLeft: 0,
      paddingRight: t.uiSpacing.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'transparent',
    },
    mainRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 0 },
    titleHitFrame: { flex: 1, alignSelf: 'stretch', alignItems: 'stretch', justifyContent: 'center' },
    titleHitSurface: { flex: 1, alignSelf: 'stretch', alignItems: 'stretch', justifyContent: 'center' },
    titleRow: { width: '100%', flexDirection: 'row', alignItems: 'flex-start', gap: t.uiSpacing.sm, paddingVertical: t.uiSpacing.sm },
    titleStacked: { alignItems: 'flex-start', flexWrap: 'wrap' },
    number: { ...planner.typography.cardTitle, color: t.colors.textSecondary, width: t.uiSpacing.lg },
    confirmedNumber: { color: t.colors.textMuted },
    title: { flex: 1, minWidth: 0, ...planner.typography.cardTitle, color: t.colors.textPrimary },
    dimTitle: { color: t.colors.textSecondary },
    droppedResult: { color: t.colors.textMuted },
    droppedTitle: { textDecorationLine: 'line-through', color: t.colors.textMuted },
    status: { flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xxs, flexShrink: 0, width: planner.typography.meta.fontSize * 6.6 },
    statusBelow: { flexBasis: '100%', paddingLeft: t.uiSpacing.lg + t.uiSpacing.sm },
    statusText: { ...planner.typography.meta, color: t.colors.textSecondary, fontWeight: '700' },
    runningDot: { width: STATUS_DOT_SIZE, height: STATUS_DOT_SIZE, borderRadius: t.foundation.radius.round, backgroundColor: t.colors.statusRunning },
    details: { paddingLeft: t.hitTarget.min, paddingRight: 0, paddingTop: t.uiSpacing.xs, gap: t.uiSpacing.xs },
    changedReason: { gap: t.uiSpacing.xxs },
    reopened: { ...planner.typography.meta, color: t.colors.warningText, fontWeight: '700' },
    result: { ...planner.typography.body, color: t.colors.textPrimary },
    evidence: { flexDirection: 'column', alignItems: 'flex-start', gap: t.uiSpacing.xs },
    evidenceImages: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: t.uiSpacing.xs },
    evidenceLinks: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: t.uiSpacing.xs },
    linkContent: { flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xxs, maxWidth: '100%' },
    imageEvidence: { width: 104, gap: t.uiSpacing.xxs },
    evidenceLabel: { ...planner.typography.meta, color: t.colors.textSecondary, flexWrap: 'wrap' },
    linkFrame: { alignSelf: 'flex-start' },
    linkSurface: { minHeight: t.controlHeight.chip, backgroundColor: t.colors.surfaceCode, maxWidth: '100%', borderRadius: t.foundation.radius.round, borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border, paddingHorizontal: t.uiSpacing.sm },
    linkText: { ...planner.typography.meta, color: t.colors.link, fontWeight: '600', flexShrink: 1 },
    footer: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: t.uiSpacing.xs },
    caveatRow: { flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xxs, flexShrink: 1 },
    caveat: { ...planner.typography.meta, color: t.colors.warningText, flexShrink: 1 },
    source: { ...planner.typography.meta, color: t.colors.textMuted },
    fixFrame: { marginLeft: 'auto', flexShrink: 0 },
    fixSurface: { minHeight: t.hitTarget.min, paddingHorizontal: t.uiSpacing.sm, borderRadius: t.foundation.radius.chip, justifyContent: 'center' },
    fixText: { ...planner.typography.meta, color: t.colors.textSecondary, textDecorationLine: 'underline' },
    pending: { position: 'absolute', right: t.uiSpacing.sm, bottom: t.uiSpacing.xxs, ...planner.typography.meta, color: t.colors.textMuted },
  });
}

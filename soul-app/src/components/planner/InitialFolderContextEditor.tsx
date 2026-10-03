import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { ApiClient } from '../../api/client';
import type { InitialFolderContext } from '../../api/initialFolderContext';
import { useTokens, type DesignTokens } from '../../theme';

export function InitialFolderContextEditor({
  visible,
  api,
  value,
  disabled,
  assignmentIncomplete,
  onChange,
  onAssignmentIncompleteChange,
  onOpenAtomPicker,
  onOpenDefaultsPicker,
}: {
  visible: boolean;
  api: ApiClient | null;
  value: InitialFolderContext;
  disabled: boolean;
  assignmentIncomplete: boolean;
  onChange(value: InitialFolderContext): void;
  onAssignmentIncompleteChange(value: boolean): void;
  onOpenAtomPicker(): void;
  onOpenDefaultsPicker(): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [expanded, setExpanded] = useState(false);
  const wasVisible = useRef(false);
  useEffect(() => {
    const opening = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (!opening) return;
    setExpanded(false);
  }, [visible]);
  return (
    <View style={styles.container}>
      <TouchableOpacity
        testID="new-task-direct-context-toggle"
        style={styles.toggle}
        onPress={() => setExpanded((current) => !current)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        disabled={disabled}
      >
        <View style={styles.toggleBody}>
          <Text style={styles.title}>이 폴더에서 직접 지정</Text>
          <Text style={styles.meta}>{contextSummary(value, assignmentIncomplete)}</Text>
        </View>
        <Text style={styles.chevron}>{expanded ? '⌃' : '⌄'}</Text>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.editor}>
          <Text style={styles.label}>폴더 지침</Text>
          <TextInput
            value={value.guidance}
            onChangeText={(guidance) => onChange({ ...value, guidance })}
            placeholder="이 폴더에서만 사용할 지침을 적어두세요."
            placeholderTextColor={t.colors.textPlaceholder}
            multiline
            editable={!disabled}
            style={styles.guidance}
          />
          <Text style={styles.label}>기본 담당</Text>
          <TouchableOpacity testID="new-task-defaults-edit" style={styles.selection} disabled={disabled} onPress={onOpenDefaultsPicker}>
            <Text style={styles.selectionValue}>{value.sessionDefaults ? `${value.sessionDefaults.agentId}, ${value.sessionDefaults.nodeId}` : '상속 / 미지정'}</Text>
            <Text style={styles.addText}>변경 ›</Text>
          </TouchableOpacity>
          <Text style={styles.label}>Atom 컨텍스트</Text>
          {value.atomReferences.map((reference) => (
            <View key={`${reference.instance}:${reference.nodeId}`} style={styles.referenceRow}>
              <View style={styles.referenceBody}>
                <Text style={styles.referenceTitle} numberOfLines={1}>{reference.nodeTitle}</Text>
                <Text style={styles.meta}>depth {reference.depth} · {reference.titlesOnly ? '제목만' : '본문 포함'}</Text>
              </View>
              <TouchableOpacity
                disabled={disabled}
                accessibilityLabel={`${reference.nodeTitle} 제거`}
                style={styles.remove}
                onPress={() => onChange({
                  ...value,
                  atomReferences: value.atomReferences.filter((item) => item !== reference),
                })}
              >
                <Text style={styles.removeText}>제거</Text>
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity
            testID="new-task-add-atom"
            style={styles.add}
            onPress={onOpenAtomPicker}
            disabled={disabled || assignmentIncomplete}
          >
            <Text style={styles.addText}>+ Atom 노드 추가</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

function contextSummary(value: InitialFolderContext, assignmentIncomplete: boolean): string {
  if (assignmentIncomplete) return '기본 담당 선택을 마쳐야 합니다.';
  const count = Number(Boolean(value.guidance.trim()))
    + value.atomReferences.length
    + Number(Boolean(value.sessionDefaults));
  return count > 0 ? `${count}개 설정` : '지침 · 기본 담당 · Atom';
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    container: { gap: t.spacing.sm },
    toggle: { minHeight: t.foundation.minHeight.field, flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    toggleBody: { flex: 1, gap: t.spacing.xxs },
    title: { color: t.colors.textPrimary, ...t.foundation.typography.cardTitle },
    meta: { color: t.colors.textTertiary, ...t.foundation.typography.meta },
    chevron: { color: t.colors.textSecondary, fontSize: t.iconSize.standard },
    editor: { gap: t.spacing.sm, paddingBottom: t.spacing.sm },
    label: { color: t.colors.textSecondary, ...t.foundation.typography.label, marginTop: t.spacing.xs },
    guidance: { minHeight: t.foundation.minHeight.memo, color: t.colors.textPrimary, ...t.foundation.typography.body, padding: t.spacing.sm, textAlignVertical: 'top' },
    selectionGroup: { gap: t.spacing.xs },
    selection: { minHeight: t.foundation.minHeight.field, flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    selectionLabel: { width: 76, color: t.colors.textSecondary, ...t.foundation.typography.label },
    selectionValue: { flex: 1, textAlign: 'right', color: t.colors.textPrimary, ...t.foundation.typography.body },
    referenceRow: { minHeight: t.foundation.minHeight.field, flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    referenceBody: { flex: 1, gap: t.spacing.xxs },
    referenceTitle: { color: t.colors.textPrimary, ...t.foundation.typography.body },
    remove: { minWidth: 56, minHeight: t.hitTarget.min, alignItems: 'flex-end', justifyContent: 'center' },
    removeText: { color: t.colors.errorText, ...t.foundation.typography.meta },
    add: { minWidth: t.hitTarget.min, minHeight: t.hitTarget.min, justifyContent: 'center' },
    addText: { color: t.colors.accent, ...t.foundation.typography.body, fontWeight: '700' },
    error: { color: t.colors.errorText, ...t.foundation.typography.meta },
    warningBadge: {
      alignSelf: 'flex-end',
      color: t.colors.textSecondary,
      ...t.foundation.typography.meta,
    },
  });
}

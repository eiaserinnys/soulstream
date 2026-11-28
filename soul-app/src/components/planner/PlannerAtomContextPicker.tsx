import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import type { AtomInstance } from '../../lib/folder-context';
import { useTokens, type DesignTokens } from '../../theme';
import { SettingsSegmentedControl } from '../settings/SettingsSegmentedControl';
import { GroupedGlassRow, GroupedGlassSheet } from './GroupedGlassSheet';
import { HeadingRow } from './FolderContextParts';
import { SheetErrorNotice, sheetErrorDetail } from './SheetErrorNotice';
import { makeStyles as makeSheetStyles } from './SessionSuccessionSheet.styles';

interface AtomNode {
  id: string;
  title: string;
}

interface AtomPickerApi {
  listAtomRootNodes(): Promise<unknown>;
  listAtomNodeChildren(nodeId: string): Promise<unknown>;
}

export interface PickedAtomReference {
  instance: AtomInstance;
  nodeId: string;
  nodeTitle: string;
  depth: number;
  titlesOnly: boolean;
}

const DEPTHS = ['1', '2', '3', '4', '5'] as const;
type DepthValue = (typeof DEPTHS)[number];
const DEFAULT_DEPTH: DepthValue = '3';

/** Reference picker: atom node, depth 1-5 and titles only. `initial` opens it as the editor of an existing row. */
export function PlannerAtomContextPicker({ visible, api, initial = null, onClose, onPicked }: {
  visible: boolean;
  api: AtomPickerApi | null;
  initial?: PickedAtomReference | null;
  onClose(): void;
  onPicked(reference: PickedAtomReference): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => ({ ...makeSheetStyles(t), ...makeStyles(t) }), [t]);
  const [breadcrumb, setBreadcrumb] = useState<AtomNode[]>([]);
  const [items, setItems] = useState<AtomNode[]>([]);
  const [selected, setSelected] = useState<AtomNode | null>(initial ? { id: initial.nodeId, title: initial.nodeTitle } : null);
  const [depth, setDepth] = useState<DepthValue>(initial ? depthValue(initial.depth) : DEFAULT_DEPTH);
  const [titlesOnly, setTitlesOnly] = useState(initial?.titlesOnly ?? false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = useRef(false);
  const current = breadcrumb[breadcrumb.length - 1];

  useEffect(() => {
    if (!visible || !api) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (current ? api.listAtomNodeChildren(current.id) : api.listAtomRootNodes()).then((payload) => {
      if (!cancelled) setItems(normalizeNodes(payload));
    }).catch((cause) => {
      if (!cancelled) {
        setItems([]);
        setError(sheetErrorDetail(cause));
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [api, current, visible]);

  const canConfirm = Boolean(selected && api && !loading && !error);
  const confirm = () => {
    if (!selected || !canConfirm || confirmed.current) return;
    confirmed.current = true;
    onPicked({
      instance: initial?.instance ?? 'atom',
      nodeId: selected.id,
      nodeTitle: selected.title,
      depth: Number(depth),
      titlesOnly,
    });
    onClose();
  };
  const selectedOutsideList = selected && selected.id !== current?.id && !items.some((item) => item.id === selected.id);

  return (
    <View style={styles.container}>
      <View testID="atom-picker-header" style={styles.header}>
        <TouchableOpacity testID="atom-picker-cancel" accessibilityRole="button" style={styles.headerButton} onPress={onClose}>
          <Text style={styles.headerAction}>취소</Text>
        </TouchableOpacity>
        <Text accessibilityRole="header" style={styles.title}>{initial ? '참고 자료 고치기' : '참고 자료 추가'}</Text>
        <TouchableOpacity testID="atom-picker-add-selected" accessibilityRole="button" style={styles.headerButton}
          disabled={!canConfirm} accessibilityState={{ disabled: !canConfirm }} onPress={confirm}>
          <Text style={[styles.headerAction, !canConfirm && styles.disabled]}>{initial ? '저장' : '추가'}</Text>
        </TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.section}>
          <HeadingRow title="노드" />
          <GroupedGlassSheet testID="atom-picker-nodes">
            {[
              current ? (
                <View key="crumb" style={styles.crumb}>
                  <TouchableOpacity testID="atom-picker-back" accessibilityRole="button" accessibilityLabel="상위로"
                    style={styles.crumbBack} onPress={() => setBreadcrumb((path) => path.slice(0, -1))}>
                    <Ionicons name="chevron-back" size={t.iconSize.compact} color={t.colors.accent} />
                  </TouchableOpacity>
                  <TouchableOpacity testID="atom-picker-select-current" accessibilityRole="radio"
                    accessibilityState={{ selected: selected?.id === current.id }} accessibilityLabel={current.title}
                    style={styles.crumbTitle} onPress={() => setSelected(current)}>
                    <Text style={styles.crumbText} numberOfLines={1}>{current.title}</Text>
                    {selected?.id === current.id ? <Ionicons testID={`atom-picker-selected-${current.id}`} name="checkmark" size={t.iconSize.standard} color={t.colors.accent} /> : null}
                  </TouchableOpacity>
                </View>
              ) : null,
              selectedOutsideList && !loading ? (
                <NodeRow key={`selected-${selected.id}`} node={selected} selected styles={styles} t={t} onSelect={() => undefined} />
              ) : null,
              ...(loading ? [<View key="loading" style={styles.state}><ActivityIndicator color={t.colors.accent} /></View>]
                : error ? []
                  : items.length === 0 ? [<Text key="empty" style={styles.empty}>하위 노드가 없습니다.</Text>]
                    : items.map((item) => (
                      <NodeRow key={item.id} node={item} selected={selected?.id === item.id} styles={styles} t={t}
                        onSelect={() => setSelected(item)} onDrill={() => setBreadcrumb((path) => [...path, item])} />
                    ))),
            ].filter(Boolean)}
          </GroupedGlassSheet>
          {error ? <SheetErrorNotice summary="자료를 불러오지 못했습니다. 닫고 다시 열어 주세요." detail={error} /> : null}
        </View>
        <View style={styles.section}>
          <GroupedGlassSheet testID="atom-picker-options">
            <View style={styles.option}>
              <Text style={styles.optionLabel}>깊이</Text>
              <SettingsSegmentedControl<DepthValue> id="atom-picker-depth" value={depth} onChange={setDepth}
                options={DEPTHS.map((value) => ({ value, label: value, accessibilityLabel: `깊이 ${value}` }))} />
            </View>
            <View style={styles.titlesOnlyRow}>
              <Text style={styles.titlesOnlyLabel}>제목만</Text>
              <Switch testID="atom-picker-titles-only" accessibilityLabel="제목만" value={titlesOnly} onValueChange={setTitlesOnly} />
            </View>
          </GroupedGlassSheet>
        </View>
      </ScrollView>
    </View>
  );
}

function NodeRow({ node, selected, styles, t, onSelect, onDrill }: {
  node: AtomNode; selected: boolean; styles: ReturnType<typeof makeStyles> & ReturnType<typeof makeSheetStyles>; t: DesignTokens;
  onSelect(): void; onDrill?(): void;
}) {
  return <GroupedGlassRow testID={`atom-picker-select-${node.id}`} selected={selected} accessibilityRole="radio"
    accessibilityLabel={node.title} onPress={onSelect} style={styles.node}>
    <Text style={styles.nodeTitle} numberOfLines={1}>{node.title}</Text>
    {selected ? <Ionicons testID={`atom-picker-selected-${node.id}`} name="checkmark" size={t.iconSize.standard} color={t.colors.accent} /> : null}
    {onDrill ? (
      <TouchableOpacity testID={`atom-picker-drill-${node.id}`} accessibilityRole="button" accessibilityLabel={`${node.title} 하위 보기`}
        style={styles.drill} onPress={onDrill}>
        <Ionicons name="chevron-forward" size={t.iconSize.compact} color={t.colors.textTertiary} />
      </TouchableOpacity>
    ) : <View style={styles.drill} />}
  </GroupedGlassRow>;
}

function depthValue(depth: number): DepthValue {
  const value = String(depth);
  return (DEPTHS as readonly string[]).includes(value) ? value as DepthValue : DEFAULT_DEPTH;
}

function normalizeNodes(payload: unknown): AtomNode[] {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.children)
      ? record.children
      : Array.isArray(record?.nodes) ? record.nodes : [];
  return raw.flatMap((value) => {
    const node = value && typeof value === 'object' ? value as Record<string, unknown> : null;
    const card = node?.card && typeof node.card === 'object' ? node.card as Record<string, unknown> : null;
    const id = node?.id ?? node?.nodeId ?? node?.node_id;
    const title = node?.title ?? node?.name ?? node?.label ?? card?.title;
    return typeof id === 'string' && typeof title === 'string'
      ? [{ id: id.trim(), title: title.trim() || '(이름 없음)' }]
      : [];
  }).filter((node) => node.id);
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    container: { flex: 1 },
    crumb: { flexDirection: 'row', alignItems: 'center', minHeight: t.hitTarget.min, paddingLeft: t.spacing.xs, paddingRight: t.spacing.sm },
    crumbBack: { minWidth: t.hitTarget.min, minHeight: t.hitTarget.min, alignItems: 'center', justifyContent: 'center' },
    crumbTitle: { flex: 1, minHeight: t.hitTarget.min, flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    crumbText: { flex: 1, color: t.colors.textSecondary, ...t.foundation.typography.label },
    node: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, paddingLeft: t.cardLayout.padding, minHeight: t.foundation.minHeight.field },
    nodeTitle: { flex: 1, color: t.colors.textPrimary, ...t.foundation.typography.body },
    drill: { minWidth: t.hitTarget.min, minHeight: t.hitTarget.min, alignItems: 'center', justifyContent: 'center' },
    state: { minHeight: t.foundation.minHeight.field, justifyContent: 'center', padding: t.cardLayout.padding },
    empty: { color: t.colors.textTertiary, ...t.foundation.typography.body, padding: t.cardLayout.padding },
    option: { padding: t.cardLayout.padding, gap: t.spacing.sm },
    optionLabel: { color: t.colors.textSecondary, ...t.foundation.typography.label },
    titlesOnlyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.spacing.sm, paddingHorizontal: t.cardLayout.padding, minHeight: t.foundation.minHeight.field },
    titlesOnlyLabel: { flex: 1, color: t.colors.textPrimary, ...t.foundation.typography.body },
  });
}

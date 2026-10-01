import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { InitialFolderAtomReference } from '../../api/initialFolderContext';
import { useTokens, type DesignTokens } from '../../theme';

interface AtomNode {
  id: string;
  title: string;
}

interface AtomPickerApi {
  listAtomRootNodes(): Promise<unknown>;
  listAtomNodeChildren(nodeId: string): Promise<unknown>;
}

export function PlannerAtomContextPicker({ visible, api, onClose, onPicked }: {
  visible: boolean;
  api: AtomPickerApi | null;
  onClose(): void;
  onPicked(reference: InitialFolderAtomReference): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [breadcrumb, setBreadcrumb] = useState<AtomNode[]>([]);
  const [items, setItems] = useState<AtomNode[]>([]);
  const [selected, setSelected] = useState<AtomNode | null>(null);
  const [depth, setDepth] = useState(3);
  const [titlesOnly, setTitlesOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasVisible = useRef(false);
  const current = breadcrumb[breadcrumb.length - 1];

  useEffect(() => {
    const opening = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (!visible) {
      setBreadcrumb([]);
      setItems([]);
      setSelected(null);
      setError(null);
      return;
    }
    if (!opening) return;
    setBreadcrumb([]);
    setSelected(null);
    setDepth(3);
    setTitlesOnly(false);
  }, [visible]);

  useEffect(() => {
    if (!visible || !api) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const request = current
      ? api.listAtomNodeChildren(current.id)
      : api.listAtomRootNodes();
    request.then((payload) => {
      if (!cancelled) setItems(normalizeNodes(payload));
    }).catch((cause) => {
      if (!cancelled) {
        setItems([]);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [api, current, visible]);

  const choose = (node: AtomNode) => {
    setSelected(node);
    setDepth(3);
    setTitlesOnly(false);
  };
  const addSelected = () => {
    if (!selected) return;
    onPicked({
      instance: 'atom',
      nodeId: selected.id,
      nodeTitle: selected.title,
      depth,
      titlesOnly,
    });
    onClose();
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerButton} onPress={onClose}>
          <Text style={styles.cancel}>취소</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{current?.title ?? 'Atom 컨텍스트'}</Text>
        <View style={styles.headerButton} />
      </View>
      {selected ? (
        <View testID={`atom-picker-selected-${selected.id}`} style={styles.selectedCard}>
          <Text style={styles.selectedTitle} numberOfLines={1}>{selected.title}</Text>
          <View style={styles.settings}>
            <Text style={styles.label}>깊이</Text>
            <View style={styles.depthRow}>
              {[1, 2, 3, 4, 5].map((value) => (
                <TouchableOpacity
                  key={value}
                  testID={`atom-picker-depth-${value}`}
                  style={[styles.depthChip, depth === value && styles.depthChipActive]}
                  onPress={() => setDepth(value)}
                >
                  <Text style={[styles.depthText, depth === value && styles.depthTextActive]}>{value}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.label}>제목만 포함</Text>
              <Switch
                testID="atom-picker-titles-only"
                value={titlesOnly}
                onValueChange={setTitlesOnly}
              />
            </View>
            <TouchableOpacity testID="atom-picker-add-selected" style={styles.addSelected} onPress={addSelected}>
              <Text style={styles.addSelectedText}>이 설정으로 추가</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : <Text style={styles.hint}>노드를 선택하면 같은 카드에서 포함 범위를 정할 수 있습니다.</Text>}
      {breadcrumb.length > 0 ? (
        <TouchableOpacity style={styles.backRow} onPress={() => setBreadcrumb((path) => path.slice(0, -1))}>
          <Text style={styles.back}>‹ 상위</Text>
        </TouchableOpacity>
      ) : null}
      {loading ? <ActivityIndicator style={styles.center} color={t.colors.accent} /> : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<Text style={styles.meta}>{error ?? '하위 노드가 없습니다.'}</Text>}
          renderItem={({ item }) => (
            <View style={styles.nodeRow}>
              <TouchableOpacity
                testID={`atom-picker-drill-${item.id}`}
                style={styles.drill}
                onPress={() => setBreadcrumb((path) => [...path, item])}
              >
                <Text style={styles.nodeTitle} numberOfLines={1}>{item.title}</Text>
                <Text style={styles.chevron}>›</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID={`atom-picker-select-${item.id}`}
                style={styles.select}
                onPress={() => choose(item)}
              >
                <Text style={styles.selectText}>선택</Text>
              </TouchableOpacity>
            </View>
          )}
        />
      )}
      {current ? (
        <TouchableOpacity testID="atom-picker-select-current" style={styles.current} onPress={() => choose(current)}>
          <Text style={styles.currentText}>“{current.title}” 선택</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
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
    header: { minHeight: t.hitTarget.min + t.spacing.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: t.foundation.pageInset },
    headerButton: { width: 64, minHeight: t.hitTarget.min, justifyContent: 'center' },
    cancel: { color: t.colors.accent, ...t.foundation.typography.body },
    title: { color: t.colors.textPrimary, ...t.foundation.typography.navigation, flex: 1, textAlign: 'center' },
    settings: { gap: t.spacing.sm, paddingHorizontal: t.foundation.pageInset, paddingVertical: t.spacing.md },
    selectedCard: { marginHorizontal: t.foundation.pageInset, backgroundColor: t.colors.surfaceMuted, borderRadius: t.radius.md, overflow: 'hidden' },
    selectedTitle: { color: t.colors.textPrimary, ...t.foundation.typography.cardTitle, paddingHorizontal: t.foundation.pageInset, paddingTop: t.spacing.md },
    hint: { color: t.colors.textTertiary, ...t.foundation.typography.meta, paddingHorizontal: t.foundation.pageInset, paddingVertical: t.spacing.md },
    label: { color: t.colors.textSecondary, ...t.foundation.typography.label },
    depthRow: { flexDirection: 'row', gap: t.spacing.sm },
    depthChip: { minWidth: t.hitTarget.min, minHeight: t.hitTarget.min, borderRadius: t.radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.surfaceMuted },
    depthChipActive: { backgroundColor: t.colors.accent },
    depthText: { color: t.colors.textPrimary, ...t.foundation.typography.body },
    depthTextActive: { color: t.colors.accentText, fontWeight: '700' },
    switchRow: { minHeight: t.hitTarget.min, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    addSelected: { minWidth: t.hitTarget.min, minHeight: t.hitTarget.min, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accent, borderRadius: t.radius.md },
    addSelectedText: { color: t.colors.accentText, ...t.foundation.typography.body, fontWeight: '700' },
    backRow: { minHeight: t.hitTarget.min, justifyContent: 'center', paddingHorizontal: t.foundation.pageInset },
    back: { color: t.colors.accent, ...t.foundation.typography.body },
    center: { flex: 1 },
    list: { paddingHorizontal: t.foundation.pageInset, paddingBottom: t.spacing.xl },
    nodeRow: { minHeight: t.foundation.minHeight.field, flexDirection: 'row', alignItems: 'center' },
    drill: { flex: 1, minHeight: t.foundation.minHeight.field, flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    nodeTitle: { flex: 1, color: t.colors.textPrimary, ...t.foundation.typography.body },
    chevron: { color: t.colors.textTertiary, fontSize: t.iconSize.standard },
    select: { minWidth: 64, minHeight: t.hitTarget.min, alignItems: 'flex-end', justifyContent: 'center' },
    selectText: { color: t.colors.accent, ...t.foundation.typography.body, fontWeight: '700' },
    meta: { color: t.colors.textTertiary, ...t.foundation.typography.meta, paddingVertical: t.spacing.lg },
    current: { minWidth: t.hitTarget.min, minHeight: t.hitTarget.min + t.spacing.md, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accent, margin: t.foundation.pageInset, borderRadius: t.radius.md },
    currentText: { color: t.colors.accentText, ...t.foundation.typography.body, fontWeight: '700' },
  });
}

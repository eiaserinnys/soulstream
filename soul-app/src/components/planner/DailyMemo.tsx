import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { PlannerBlock } from '../../api/plannerTypes';
import { mergeServerDraft } from '../../lib/server-draft';
import { usePersistentDraft } from '../../hooks/usePersistentDraft';
import { createPlannerVisualRoles, useDeviceType, useTokens, type DesignTokens } from '../../theme';
import { AppGlassCard } from '../AppGlassCard';
import { TabletMarkdownEditor } from './TabletMarkdownEditor';
import { captureAuthScope, useAuthScopeGeneration } from '../../lib/auth-scope';

type SaveMemo = (blockId: string | null, text: string) => Promise<unknown> | void;
export function DailyMemo({ blocks, onSave, date, folderId }: {
  blocks: readonly PlannerBlock[];
  onSave?: SaveMemo;
  date?: string;
  folderId?: string;
}) {
  const t = useTokens();
  const tablet = useDeviceType() !== 'phone';
  const generation = useAuthScopeGeneration();
  const styles = useMemo(() => makeStyles(t), [t]);
  const newDraft = usePersistentDraft('daily-memo-new', [date, folderId], '');
  const { value: newMemo, setValue: setNewMemo } = newDraft;
  const savingNewMemo = useRef(false);
  const saveNewMemo = () => {
    const text = newMemo.trim();
    if (!newDraft.ready || !text || !onSave || savingNewMemo.current) return;
    savingNewMemo.current = true;
    void Promise.resolve().then(() => onSave(null, text)).then(() => {
      newDraft.clearIfMatches(newMemo);
    }).catch(() => {
      // The caller reports the save error; the draft remains available.
    }).finally(() => { savingNewMemo.current = false; });
  };
  return (
    <AppGlassCard testID="daily-memo-box" style={tablet ? styles.container : styles.phoneContainer}>
      {tablet ? <Text style={styles.title}>메모</Text> : null}
      {blocks.map(block => <MemoBlock key={`${generation}:${block.id}`} block={block} onSave={onSave} tablet={tablet} styles={styles} />)}
      {blocks.length === 0 && !onSave ? <Text style={styles.placeholder}>오늘 메모가 없습니다.</Text> : null}
      {onSave && !tablet ? (
        <TextInput testID="daily-memo-new-input" value={newMemo} onChangeText={setNewMemo}
          editable={newDraft.ready} onSubmitEditing={saveNewMemo} onBlur={saveNewMemo}
          submitBehavior="submit" returnKeyType="done" placeholder="오늘 기억해 둘 내용을 적으세요."
          placeholderTextColor={t.colors.textPlaceholder} style={styles.phoneInput} />
      ) : null}
      {onSave && tablet ? (
        <View style={styles.newRow}>
          <TextInput testID="daily-memo-new-input" value={newMemo} onChangeText={setNewMemo}
            editable={newDraft.ready} placeholder="메모 추가" placeholderTextColor={t.colors.textPlaceholder}
            style={[styles.input, styles.newInput]} />
          <TouchableOpacity testID="daily-memo-add-action" style={styles.addAction}
            disabled={!newDraft.ready} onPress={saveNewMemo}><Text style={styles.add}>추가</Text></TouchableOpacity>
        </View>
      ) : null}
    </AppGlassCard>
  );
}

function MemoBlock({ block, onSave, tablet, styles }: {
  block: PlannerBlock; onSave?: SaveMemo; tablet: boolean; styles: ReturnType<typeof makeStyles>;
}) {
  const generation = useAuthScopeGeneration();
  const [serverValue, setServerValue] = useState(block.text);
  const serverRef = useRef(block.text);
  const form = usePersistentDraft('daily-memo', [block.id], serverValue);
  const currentDraft = useRef(form.value);
  currentDraft.current = form.value;
  useEffect(() => {
    const merged = mergeServerDraft(currentDraft.current, serverRef.current, block.text);
    serverRef.current = merged.server;
    setServerValue(merged.server);
  }, [block.text]);
  const save = async (submitted: string) => {
    if (!form.ready || !onSave) return;
    const submittedGeneration = generation;
    await onSave(block.id, submitted);
    form.clearIfMatches(submitted);
    if (captureAuthScope().generation !== submittedGeneration) return;
    serverRef.current = submitted;
    setServerValue(submitted);
  };
  if (tablet && onSave) return (
    <TabletMarkdownEditor ready={form.ready} contentOnly testID={`daily-memo-${block.id}`}
      ownerKey={`${generation}\u0000${block.id}`} value={serverValue} draft={form.value}
      onChangeDraft={form.setValue} onCancel={form.clear}
      onSave={save} emptyText="오늘 메모가 없습니다." />
  );
  const saveDraft = () => {
    if (form.value !== serverValue) void save(form.value).catch(() => {
      // The caller reports the save error; keep the unsaved draft.
    });
  };
  return <TextInput testID={`daily-memo-${block.id}-input`} value={form.value}
    onChangeText={form.setValue} onBlur={saveDraft} onSubmitEditing={tablet ? undefined : saveDraft}
    submitBehavior={tablet ? undefined : 'submit'} returnKeyType={tablet ? undefined : 'done'}
    editable={!!onSave && form.ready} multiline style={tablet ? styles.input : styles.phoneInput} />;
}
function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    container: {
      padding: t.cardLayout.padding,
      gap: t.cardLayout.gap,
    },
    phoneContainer: {
      minHeight: t.foundation.minHeight.composer,
      paddingHorizontal: t.cardLayout.padding,
      paddingVertical: 0,
    },
    phoneInput: {
      minHeight: t.foundation.minHeight.composer,
      color: t.colors.textSecondary,
      ...planner.typography.body,
      padding: 0,
      textAlignVertical: 'center',
    },
    title: { color: t.colors.textPrimary, ...planner.typography.section },
    input: {
      minHeight: planner.minHeight.memo,
      color: t.colors.textSecondary,
      ...planner.typography.body,
      padding: 0,
      textAlignVertical: 'top',
    },
    newRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    newInput: { flex: 1, minHeight: planner.minHeight.context, textAlignVertical: 'center' },
    add: { color: t.colors.accent, fontWeight: '700' },
    addAction: {
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    placeholder: { color: t.colors.textPlaceholder, ...planner.typography.body },
  });
}

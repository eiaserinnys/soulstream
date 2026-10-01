import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { PlannerBlock } from '../../api/plannerTypes';
import { mergeServerDraft } from '../../lib/server-draft';
import { createPlannerVisualRoles, useDeviceType, useTokens, type DesignTokens } from '../../theme';
import { AppGlassCard } from '../AppGlassCard';
import { TabletMarkdownEditor } from './TabletMarkdownEditor';
import { captureAuthScope, useAuthScopeGeneration } from '../../lib/auth-scope';

export function DailyMemo({
  blocks,
  onSave,
}: {
  blocks: readonly PlannerBlock[];
  onSave?: (blockId: string | null, text: string) => Promise<unknown> | void;
}) {
  const t = useTokens();
  const tablet = useDeviceType() !== 'phone';
  const styles = useMemo(() => makeStyles(t), [t]);
  const scopeGeneration = useAuthScopeGeneration();
  const draftScope = useRef(scopeGeneration);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newMemo, setNewMemo] = useState('');
  const savingNewMemo = useRef(false);
  const draftValues = useRef<Record<string, string>>({});
  const serverValues = useRef<Record<string, string>>({});
  const ownsDrafts = draftScope.current === scopeGeneration;
  const visibleBlocks = ownsDrafts ? blocks : [];
  useEffect(() => {
    if (draftScope.current === scopeGeneration) return;
    draftScope.current = scopeGeneration;
    draftValues.current = {};
    serverValues.current = {};
    setDrafts({});
    setNewMemo('');
  }, [scopeGeneration]);
  useEffect(() => {
    const nextDrafts: Record<string, string> = {};
    const nextServers: Record<string, string> = {};
    for (const block of visibleBlocks) {
      const previousServer = serverValues.current[block.id] ?? block.text;
      const merged = mergeServerDraft(
        draftValues.current[block.id] ?? previousServer,
        previousServer,
        block.text,
      );
      nextDrafts[block.id] = merged.draft;
      nextServers[block.id] = merged.server;
    }
    draftValues.current = nextDrafts;
    serverValues.current = nextServers;
    setDrafts(nextDrafts);
  }, [visibleBlocks]);
  const saveNewMemo = () => {
    const text = newMemo.trim();
    if (!text || !onSave || savingNewMemo.current) return;
    const submittedGeneration = scopeGeneration;
    savingNewMemo.current = true;
    void Promise.resolve(onSave(null, text)).then(() => {
      if (captureAuthScope().generation !== submittedGeneration) return;
      setNewMemo((current) => current.trim() === text ? '' : current);
    }).finally(() => { savingNewMemo.current = false; });
  };
  return (
    <AppGlassCard testID="daily-memo-box" style={tablet ? styles.container : styles.phoneContainer}>
      {tablet ? <Text style={styles.title}>메모</Text> : null}
      {visibleBlocks.map((block) => {
        const draft = drafts[block.id] ?? block.text;
        const serverValue = serverValues.current[block.id] ?? block.text;
        const changeDraft = (text: string) => {
          draftValues.current = { ...draftValues.current, [block.id]: text };
          setDrafts((current) => ({ ...current, [block.id]: text }));
        };
        if (tablet && onSave) {
          return (
            <TabletMarkdownEditor
              key={block.id}
              contentOnly
              testID={`daily-memo-${block.id}`}
              ownerKey={`${scopeGeneration}\u0000${block.id}`}
              value={serverValue}
              draft={draft}
              onChangeDraft={changeDraft}
              onCancel={() => changeDraft(serverValue)}
              onSave={(submittedDraft) => {
                const submittedGeneration = scopeGeneration;
                return Promise.resolve(onSave(block.id, submittedDraft)).then(() => {
                  if (captureAuthScope().generation !== submittedGeneration) return;
                  serverValues.current = { ...serverValues.current, [block.id]: submittedDraft };
                  // ref 갱신만으로는 자식 props가 바뀌지 않는다. 성공 직후 read markdown과
                  // dirty guard가 저장값을 보도록 새 객체로 한 번 렌더한다.
                  setDrafts((current) => ({ ...current }));
                });
              }}
              emptyText="오늘 메모가 없습니다."
            />
          );
        }
        const saveDraft = () => {
          const submittedDraft = draftValues.current[block.id] ?? draft;
          if (submittedDraft !== serverValue) {
            const submittedGeneration = scopeGeneration;
            void Promise.resolve(onSave?.(block.id, submittedDraft)).then(() => {
              if (captureAuthScope().generation !== submittedGeneration) return;
              serverValues.current = { ...serverValues.current, [block.id]: submittedDraft };
            });
          }
        };
        return (
          <TextInput
            key={block.id}
            testID={`daily-memo-${block.id}-input`}
            value={draft}
            onChangeText={changeDraft}
            onBlur={saveDraft}
            onSubmitEditing={tablet ? undefined : saveDraft}
            submitBehavior={tablet ? undefined : 'submit'}
            returnKeyType={tablet ? undefined : 'done'}
            editable={!!onSave}
            multiline
            style={tablet ? styles.input : styles.phoneInput}
          />
        );
      })}
      {visibleBlocks.length === 0 && !onSave ? <Text style={styles.placeholder}>오늘 메모가 없습니다.</Text> : null}
      {onSave && !tablet ? (
        <TextInput
          testID="daily-memo-new-input"
          value={newMemo}
          onChangeText={setNewMemo}
          onSubmitEditing={saveNewMemo}
          onBlur={saveNewMemo}
          submitBehavior="submit"
          returnKeyType="done"
          placeholder="오늘 기억해 둘 내용을 적으세요."
          placeholderTextColor={t.colors.textPlaceholder}
          style={styles.phoneInput}
        />
      ) : null}
      {onSave && tablet ? (
        <View style={styles.newRow}>
          <TextInput
            testID="daily-memo-new-input"
            value={newMemo}
            onChangeText={setNewMemo}
            placeholder="메모 추가"
            placeholderTextColor={t.colors.textPlaceholder}
            style={[styles.input, styles.newInput]}
          />
          <TouchableOpacity
            testID="daily-memo-add-action"
            style={styles.addAction}
            onPress={saveNewMemo}
          >
            <Text style={styles.add}>추가</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </AppGlassCard>
  );
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

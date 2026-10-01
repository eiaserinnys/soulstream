import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { PlannerForegroundCard } from './PlannerForegroundCard';
import { PlannerMarkdownText } from './PlannerMarkdownText';

export interface TabletMarkdownSaveAttempt {
  ownerKey: string;
  token: number;
}

export function TabletMarkdownEditor({
  value,
  draft,
  onChangeDraft,
  onSave,
  onCancel,
  emptyText,
  testID,
  ownerKey = testID,
  contentOnly = false,
}: {
  value: string;
  draft: string;
  onChangeDraft(value: string): void;
  onSave(
    submittedDraft: string,
    attempt: Readonly<TabletMarkdownSaveAttempt>,
  ): Promise<unknown> | void;
  onCancel(): void;
  emptyText: string;
  testID: string;
  ownerKey?: string;
  /** Parent already owns the material surface; render editor content without another card. */
  contentOnly?: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const draftRef = useRef(draft);
  const ownerRef = useRef(ownerKey);
  const inputRef = useRef<TextInput>(null);
  const nextSaveToken = useRef(0);
  const activeSaveAttempt = useRef<TabletMarkdownSaveAttempt | null>(null);
  draftRef.current = draft;
  const dirty = draft !== value;
  const owned = ownerRef.current === ownerKey;
  const Surface = contentOnly ? View : PlannerForegroundCard;
  useEffect(() => {
    if (ownerRef.current === ownerKey) return;
    ownerRef.current = ownerKey;
    activeSaveAttempt.current = null;
    setEditing(false);
    setSaving(false);
  }, [ownerKey]);

  const isCurrentSaveAttempt = (attempt: Readonly<TabletMarkdownSaveAttempt>) => {
    const active = activeSaveAttempt.current;
    return ownerRef.current === attempt.ownerKey
      && active?.ownerKey === attempt.ownerKey
      && active.token === attempt.token;
  };
  const blurInput = () => TextInput.State.blurTextInput(inputRef.current ?? undefined);

  if (!editing || !owned) {
    return (
      <Surface testID={`${testID}-read`} style={styles.surface}>
        {value.trim() ? (
          <PlannerMarkdownText markdown={value} testID={`${testID}-markdown`} />
        ) : <Text style={styles.empty}>{emptyText}</Text>}
        <TouchableOpacity
          testID={`${testID}-edit-action`}
          accessibilityLabel="설명 편집"
          style={styles.editAction}
          onPress={() => setEditing(true)}
        >
          <Text style={styles.actionText}>편집</Text>
        </TouchableOpacity>
      </Surface>
    );
  }

  return (
    <View testID={`${testID}-edit`}>
      <Surface style={styles.surface}>
        <TextInput
          ref={inputRef}
          testID={`${testID}-input`}
          value={draft}
          onChangeText={onChangeDraft}
          multiline
          placeholder={emptyText}
          placeholderTextColor={t.colors.textPlaceholder}
          style={styles.input}
        />
      </Surface>
      <View testID={`${testID}-actions`} style={styles.actions}>
        <TouchableOpacity
          testID={`${testID}-cancel-action`}
          style={styles.action}
          disabled={saving}
          onPress={() => {
            if (activeSaveAttempt.current) return;
            blurInput();
            onCancel();
            setEditing(false);
          }}
        >
          <Text style={styles.secondaryAction}>취소</Text>
        </TouchableOpacity>
        {dirty ? (
          <TouchableOpacity
            testID={`${testID}-save-action`}
            style={styles.action}
            disabled={saving}
            onPress={() => {
              if (activeSaveAttempt.current) return;
              const submittedDraft = draftRef.current;
              const attempt = {
                ownerKey,
                token: nextSaveToken.current + 1,
              };
              nextSaveToken.current = attempt.token;
              activeSaveAttempt.current = attempt;
              setSaving(true);
              let request: Promise<unknown>;
              try {
                request = Promise.resolve(onSave(submittedDraft, attempt));
              } catch (error) {
                request = Promise.reject(error);
              }
              void request
                .then(() => {
                  if (
                    isCurrentSaveAttempt(attempt)
                    && draftRef.current === submittedDraft
                  ) {
                    blurInput();
                    setEditing(false);
                  }
                })
                .catch(() => undefined)
                .finally(() => {
                  if (!isCurrentSaveAttempt(attempt)) return;
                  activeSaveAttempt.current = null;
                  setSaving(false);
                });
            }}
          >
            <Text style={styles.actionText}>{saving ? '저장 중…' : '변경사항 저장'}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    surface: { padding: t.cardLayout.padding, gap: t.uiSpacing.sm },
    input: {
      minHeight: planner.minHeight.memo,
      color: t.colors.textPrimary,
      ...planner.typography.body,
      padding: 0,
      textAlignVertical: 'top',
    },
    empty: { color: t.colors.textPlaceholder, ...planner.typography.body },
    editAction: {
      alignSelf: 'flex-end',
      minWidth: planner.actionColumn,
      minHeight: planner.actionColumn,
      alignItems: 'flex-end',
      justifyContent: 'center',
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      alignItems: 'center',
      gap: t.uiSpacing.sm,
    },
    action: {
      minWidth: planner.actionColumn,
      minHeight: planner.actionColumn,
      alignItems: 'flex-end',
      justifyContent: 'center',
    },
    actionText: { color: t.colors.accent, fontWeight: '700' },
    secondaryAction: { color: t.colors.textSecondary, fontWeight: '600' },
  });
}

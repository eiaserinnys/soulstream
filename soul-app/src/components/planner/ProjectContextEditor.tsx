import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { PlannerBlock } from '../../api/plannerTypes';
import { usePlannerActions } from '../../hooks/usePlannerActions';
import { usePlannerPageDetail } from '../../hooks/usePlannerReads';
import { mergeServerDraft } from '../../lib/server-draft';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { PlannerForegroundCard } from './PlannerForegroundCard';
import { PlannerSectionHeader } from './PlannerSectionHeader';
import {
  captureAuthScope,
  isAuthScopeCurrent,
  useAuthScopeGeneration,
} from '../../lib/auth-scope';

export function ProjectContextEditor({
  api,
  projectPageId,
  active,
}: {
  api: ApiClient | null;
  projectPageId: string;
  active: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const actions = usePlannerActions(api);
  const detail = usePlannerPageDetail(api, projectPageId, active);
  const scopeGeneration = useAuthScopeGeneration();
  const ownerKey = `${scopeGeneration}\u0000${projectPageId}`;
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const draft = useRef('');
  const server = useRef('');
  const draftOwner = useRef(ownerKey);

  useEffect(() => {
    if (draftOwner.current !== ownerKey || !detail.data) {
      draftOwner.current = ownerKey;
      draft.current = '';
      server.current = '';
      setText('');
      setSaved('');
      setSaving(false);
      setEditing(false);
      setExpanded(false);
      if (!detail.data) return;
    }
    const value = detail.data.blocks.filter(isDescriptionBlock).map((block) => block.text).join('\n\n');
    if (draft.current === '' && server.current === '') {
      draft.current = value;
      server.current = value;
      setText(value);
      setSaved(value);
      return;
    }
    const merged = mergeServerDraft(draft.current, server.current, value);
    draft.current = merged.draft;
    server.current = merged.server;
    setText(merged.draft);
    setSaved(merged.server);
  }, [detail.data, ownerKey]);

  const save = async () => {
    const scope = captureAuthScope();
    const submittedOwner = ownerKey;
    const submittedText = draft.current;
    setSaving(true);
    try {
      await actions.saveProjectContext(projectPageId, submittedText);
      if (!isAuthScopeCurrent(scope) || draftOwner.current !== submittedOwner) return;
      server.current = submittedText;
      setSaved(submittedText);
      setEditing(false);
    } catch (error) {
      if (isAuthScopeCurrent(scope) && draftOwner.current === submittedOwner) {
        Alert.alert('프로젝트 컨텍스트를 저장하지 못했습니다.', errorText(error));
      }
    } finally {
      if (isAuthScopeCurrent(scope) && draftOwner.current === submittedOwner) setSaving(false);
    }
  };

  const owned = draftOwner.current === ownerKey;
  const visibleText = owned ? text : '';
  const visibleSaved = owned ? saved : '';
  const canExpand = visibleSaved.length > 220 || visibleSaved.split('\n').length > 8;

  return (
    <View style={styles.container}>
      <PlannerSectionHeader title="프로젝트 컨텍스트" testID="planner-section-header-context"
        actionLabel={!editing ? '편집' : undefined}
        onAction={!editing ? () => setEditing(true) : undefined} />
      {detail.error ? <Text style={styles.error}>{detail.error}</Text> : null}
      <PlannerForegroundCard glassTestID="folder-context-glass" foregroundTestID="folder-context-foreground">
        {editing ? (
          <TextInput
            value={visibleText}
            onChangeText={(value) => {
              draft.current = value;
              setText(value);
            }}
            multiline
            placeholder="이 프로젝트의 공통 지침"
            placeholderTextColor={t.colors.textPlaceholder}
            style={styles.input}
          />
        ) : <>
          <Text testID="folder-context-read-text" numberOfLines={expanded ? undefined : 8} style={styles.readText}>
            {visibleSaved || '이 프로젝트의 공통 지침이 없습니다.'}
          </Text>
          {canExpand ? (
            <TouchableOpacity style={styles.expandAction} onPress={() => setExpanded((value) => !value)}>
              <Text style={styles.save}>{expanded ? '접기' : '펼치기'}</Text>
            </TouchableOpacity>
          ) : null}
        </>}
      </PlannerForegroundCard>
      {editing ? (
        <View style={styles.actions}>
          <TouchableOpacity style={styles.saveAction} onPress={() => {
            draft.current = server.current;
            setText(server.current);
            setEditing(false);
          }} disabled={saving}>
            <Text style={styles.save}>취소</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.saveAction} onPress={save} disabled={saving || visibleText === visibleSaved}>
            <Text style={[styles.save, (saving || visibleText === visibleSaved) && styles.disabled]}>
              {saving ? '저장 중…' : '컨텍스트 저장'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

function isDescriptionBlock(block: PlannerBlock) {
  return block.parentId === null
    && !/^\[\[[^\]]+\]\]$/.test(block.text.trim())
    && block.blockType !== 'context'
    && block.properties.kind !== 'context';
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    container: { gap: t.spacing.sm },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: t.spacing.sm },
    error: { color: t.colors.errorText, ...planner.typography.meta },
    readText: { color: t.colors.textPrimary, ...planner.typography.body, padding: t.cardLayout.padding },
    input: {
      minHeight: planner.minHeight.memo, color: t.colors.textPrimary,
      ...planner.typography.body,
      padding: t.cardLayout.padding, textAlignVertical: 'top',
    },
    save: { color: t.colors.accent, ...planner.typography.label, paddingVertical: t.spacing.xs },
    saveAction: {
      minWidth: planner.actionColumn,
      minHeight: planner.actionColumn,
      alignItems: 'center',
      justifyContent: 'center',
    },
    expandAction: { alignSelf: 'flex-start', minWidth: planner.actionColumn, minHeight: planner.actionColumn,
      justifyContent: 'center', marginLeft: t.cardLayout.padding, marginBottom: t.spacing.xs },
    disabled: { opacity: 0.45 },
  });
}

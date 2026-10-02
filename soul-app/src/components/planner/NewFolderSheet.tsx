import { usePersistentDraft } from '../../hooks/usePersistentDraft';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { Folder } from '../../api/types';
import type { ApiClient } from '../../api/client';
import {
  emptyInitialFolderContext,
  type InitialFolderAtomReference,
  type InitialFolderContext,
} from '../../api/initialFolderContext';
import { usePlannerPageDetail } from '../../hooks/usePlannerReads';
import { buildPlannerContextPresentation } from '../../lib/planner-context-presentation';
import { useTokens, type DesignTokens } from '../../theme';
import { AppModalSurface } from '../AppModalSurface';
import { AppKeyboardAvoidingView } from '../AppKeyboardAvoidingView';
import { buildNewFolderSubmission, projectOptionsFromFolders } from './newFolderCreation';
import { InitialFolderContextEditor } from './InitialFolderContextEditor';
import { PlannerAtomContextPicker } from './PlannerAtomContextPicker';
import {
  captureAuthScope,
  isAuthScopeCurrent,
  useAuthScopeGeneration,
} from '../../lib/auth-scope';

export function NewFolderSheet({
  visible,
  api,
  folders,
  dailyDate,
  defaultProjectPageId = null,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  api: ApiClient | null;
  folders: readonly Folder[];
  dailyDate: string;
  defaultProjectPageId?: string | null;
  onClose(): void;
  onSubmit(input: {
    title: string;
    description: string;
    folderId: string;
    projectPageId: string;
    initialContext: InitialFolderContext;
    dailyDate?: string;
  }): Promise<unknown>;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const options = useMemo(() => projectOptionsFromFolders(folders), [folders]);
  const scopeGeneration = useAuthScopeGeneration();
  const [title, setTitle] = useState('');
  const descriptionDraft = usePersistentDraft('folder-create-description', [defaultProjectPageId ?? 'root'], '');
  const { value: description, setValue: setDescription } = descriptionDraft;
  const guidanceDraft = usePersistentDraft('folder-create-guidance', [defaultProjectPageId ?? 'root'], '');
  const ready = descriptionDraft.ready && guidanceDraft.ready;
  const [projectPageId, setProjectPageId] = useState('');
  const [mountToday, setMountToday] = useState(true);
  const [initialContext, setInitialContext] = useState<InitialFolderContext>(emptyInitialFolderContext);
  const [assignmentIncomplete, setAssignmentIncomplete] = useState(false);
  const [atomPickerOpen, setAtomPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasVisible = useRef(false);
  const draftScopeGeneration = useRef(scopeGeneration);
  const openingDefaults = useRef({
    defaultProjectPageId,
    firstProjectPageId: options[0]?.projectPageId ?? '',
  });
  openingDefaults.current = {
    defaultProjectPageId,
    firstProjectPageId: options[0]?.projectPageId ?? '',
  };

  useEffect(() => {
    const opening = visible && !wasVisible.current;
    const scopeChanged = draftScopeGeneration.current !== scopeGeneration;
    wasVisible.current = visible;
    draftScopeGeneration.current = scopeGeneration;
    if (!visible || (!opening && !scopeChanged)) return;
    const defaults = openingDefaults.current;
    setTitle('');
    setProjectPageId(defaults.defaultProjectPageId ?? defaults.firstProjectPageId);
    setMountToday(true);
    setInitialContext(emptyInitialFolderContext());
    setAssignmentIncomplete(false);
    setAtomPickerOpen(false);
    setSubmitting(false);
    setError(null);
  }, [scopeGeneration, visible]);

  const ownsDraft = draftScopeGeneration.current === scopeGeneration;
  const visibleProjectPageId = ownsDraft ? projectPageId : '';
  const visibleTitle = ownsDraft ? title : '';
  const visibleDescription = ownsDraft ? description : '';
  const visibleInitialContext = ownsDraft ? { ...initialContext, guidance: guidanceDraft.value } : emptyInitialFolderContext();
  const selectedProject = options.find((option) => option.projectPageId === visibleProjectPageId);
  const projectContext = usePlannerPageDetail(api, visibleProjectPageId || null, visible);
  const contextPresentation = buildPlannerContextPresentation({
    projectName: selectedProject?.name ?? '폴더',
    projectBlocks: projectContext.data?.blocks ?? [],
    folderBlocks: [],
  });
  const pickProject = () => {
    const labels = [...options.map((option) => option.name), '취소'];
    ActionSheetIOS.showActionSheetWithOptions({
      title: '상위 폴더 선택',
      options: labels,
      cancelButtonIndex: labels.length - 1,
    }, (index) => {
      if (index < options.length) setProjectPageId(options[index]!.projectPageId);
    });
  };

  const submit = async () => {
    if (!ready) return;
    const scope = captureAuthScope();
    const submittedDescription = description;
    const submittedGuidance = guidanceDraft.value;
    const submittedGeneration = scopeGeneration;
    setError(null);
    try {
      const input = buildNewFolderSubmission({
        title: visibleTitle,
        description: visibleDescription,
        selectedProjectPageId: visibleProjectPageId,
        mountToday,
        dailyDate,
        initialContext: visibleInitialContext,
      }, options);
      setSubmitting(true);
      await onSubmit(input);
      if (isAuthScopeCurrent(scope) && draftScopeGeneration.current === submittedGeneration) {
        descriptionDraft.clearIfMatches(submittedDescription);
        guidanceDraft.clearIfMatches(submittedGuidance);
        onClose();
      }
    } catch (cause) {
      if (isAuthScopeCurrent(scope) && draftScopeGeneration.current === submittedGeneration) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (isAuthScopeCurrent(scope) && draftScopeGeneration.current === submittedGeneration) {
        setSubmitting(false);
      }
    }
  };

  const canSubmit = Boolean(
    ready && visibleTitle.trim() && visibleProjectPageId && !assignmentIncomplete && !submitting,
  );
  const addAtomReference = (reference: InitialFolderAtomReference) => {
    setInitialContext((current) => ({
      ...current,
      atomReferences: [
        ...current.atomReferences.filter((item) => (
          item.instance !== reference.instance || item.nodeId !== reference.nodeId
        )),
        reference,
      ],
    }));
    setAtomPickerOpen(false);
  };
  return (
    <AppModalSurface
      visible={visible}
      variant="expanded"
      modalId="modal_new_task"
      presentationStyle="pageSheet"
      onRequestClose={() => atomPickerOpen ? setAtomPickerOpen(false) : onClose()}
      safeAreaTestID="new-task-safe-area"
    >
      {atomPickerOpen ? (
        <PlannerAtomContextPicker
          visible
          api={api}
          onClose={() => setAtomPickerOpen(false)}
          onPicked={addAtomReference}
        />
      ) : <>
      <View testID="new-task-header" style={styles.header}>
            <TouchableOpacity style={styles.headerButton} onPress={onClose}><Text style={styles.headerAction}>취소</Text></TouchableOpacity>
            <Text testID="new-task-header-title" style={styles.headerTitle}>새 폴더</Text>
            <TouchableOpacity testID="new-task-submit" style={styles.headerButton} onPress={submit} disabled={!canSubmit}>
              {submitting
                ? <ActivityIndicator color={t.colors.accent} />
                : <Text style={[styles.headerAction, !canSubmit && styles.disabled]}>만들기</Text>}
            </TouchableOpacity>
      </View>
      <AppKeyboardAvoidingView testID="new-task-keyboard" style={styles.keyboard} behavior={Platform.OS === 'ios' ? 'height' : undefined}>
            <ScrollView testID="new-task-content" contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>상위 폴더</Text>
              <View style={styles.field}>
                <TouchableOpacity
                  testID="new-task-project-selection"
                  style={styles.selection}
                  onPress={pickProject}
                  accessibilityRole="button"
                  accessibilityLabel="상위 폴더 선택"
                >
                  <Text style={styles.selectionText}>{selectedProject?.name ?? '상위 폴더 선택'}</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.label}>폴더 이름</Text>
              <View style={styles.field}>
                <TextInput
                  value={visibleTitle}
                  onChangeText={setTitle}
                  placeholder="폴더 이름"
                  placeholderTextColor={t.colors.textPlaceholder}
                  style={styles.titleInput}
                  autoFocus
                />
              </View>
              <Text style={styles.label}>설명</Text>
              <View style={styles.field}>
                <TextInput
                  editable={ready && !submitting}
                  value={visibleDescription}
                  onChangeText={setDescription}
                  placeholder="목표와 완료 조건을 적어두세요."
                  placeholderTextColor={t.colors.textPlaceholder}
                  style={styles.descriptionInput}
                  multiline
                />
              </View>
              <Text style={styles.label}>컨텍스트 · {selectedProject?.name ?? '프로젝트'}</Text>
              <View style={styles.contextPreview}>
                {projectContext.loading && !projectContext.data
                  ? <ActivityIndicator color={t.colors.accent} />
                  : null}
                    {projectContext.error ? (
                      <Text style={styles.error} accessibilityRole="alert">
                        {projectContext.error}
                      </Text>
                    ) : null}
                <ContextPreviewRow
                  label="지침"
                  values={contextPresentation.contexts
                    .filter((item) => item.kind === 'guidance')
                    .map((item) => ({ value: item.label, source: item.sourceLabel }))}
                  styles={styles}
                />
                <ContextPreviewRow
                  label="atom"
                  values={contextPresentation.contexts
                    .filter((item) => item.kind === 'atom')
                    .map((item) => ({ value: item.label, source: item.sourceLabel }))}
                  styles={styles}
                />
                <ContextPreviewRow
                  label="기본 담당"
                  values={contextPresentation.assignment ? [{
                    value: `${contextPresentation.assignment.agentId ?? 'agent 미지정'}@${contextPresentation.assignment.nodeId ?? 'node 미지정'}`,
                    source: contextPresentation.assignment.sourceLabel,
                  }] : []}
                  styles={styles}
                />
              </View>
              <InitialFolderContextEditor
                key={scopeGeneration}
                visible={visible && ownsDraft}
                api={api}
                value={visibleInitialContext}
                disabled={submitting || !ready}
                assignmentIncomplete={assignmentIncomplete}
                onChange={(value) => { setInitialContext(value); guidanceDraft.setValue(value.guidance); }}
                onAssignmentIncompleteChange={setAssignmentIncomplete}
                onOpenAtomPicker={() => setAtomPickerOpen(true)}
              />
              <TouchableOpacity
                testID="new-task-today-row"
                style={styles.todayRow}
                onPress={() => setMountToday((current) => !current)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: mountToday }}
              >
                <Text style={styles.check}>{mountToday ? '✓' : '○'}</Text>
                <View style={styles.todayBody}>
                  <Text style={styles.rowTitle}>오늘에 마운트</Text>
                  <Text style={styles.meta}>{dailyDate}</Text>
                </View>
              </TouchableOpacity>
              {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
            </ScrollView>
      </AppKeyboardAvoidingView>
      </>}
    </AppModalSurface>
  );
}

function ContextPreviewRow({
  label,
  values,
  styles,
}: {
  label: string;
  values: Array<{ value: string; source: string }>;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.contextRow}>
      <Text style={styles.contextLabel}>{label}</Text>
      <View style={styles.contextValues}>
        {values.length === 0 ? <Text style={styles.meta}>없음</Text> : values.map((item, index) => (
          <View key={`${item.value}:${index}`} style={styles.contextValueRow}>
            <Text style={styles.contextValue} numberOfLines={2}>{item.value}</Text>
            <Text style={styles.contextSource} numberOfLines={1}>· {item.source}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    keyboard: { flex: 1 },
    header: {
      minHeight: t.hitTarget.min + t.spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: t.foundation.pageInset,
    },
    headerButton: {
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      justifyContent: 'center',
    },
    headerAction: { color: t.colors.accent, ...t.foundation.typography.body, fontWeight: '700' },
    disabled: { color: t.colors.textMuted },
    headerTitle: { color: t.colors.textPrimary, ...t.foundation.typography.navigation },
    content: { paddingHorizontal: t.foundation.pageInset, paddingVertical: t.spacing.lg, gap: t.spacing.md, paddingBottom: t.spacing.xl },
    field: { minHeight: t.foundation.minHeight.field },
    label: { color: t.colors.textSecondary, ...t.foundation.typography.label },
    selection: { minHeight: t.foundation.minHeight.field, justifyContent: 'center', paddingHorizontal: t.spacing.sm },
    selectionText: { color: t.colors.textPrimary, ...t.foundation.typography.body },
    titleInput: { minHeight: t.foundation.minHeight.field, color: t.colors.textPrimary, ...t.foundation.typography.cardTitle, padding: t.spacing.sm },
    descriptionInput: { minHeight: t.foundation.minHeight.field * 3, color: t.colors.textPrimary, ...t.foundation.typography.body, padding: t.spacing.sm, textAlignVertical: 'top' },
    contextPreview: { gap: t.spacing.md, paddingVertical: t.spacing.sm },
    contextRow: { flexDirection: 'row', alignItems: 'flex-start', gap: t.spacing.sm },
    contextLabel: { width: 72, color: t.colors.textSecondary, ...t.foundation.typography.label },
    contextValues: { flex: 1, gap: t.spacing.xs },
    contextValueRow: { flexDirection: 'row', alignItems: 'flex-start', gap: t.spacing.sm },
    contextValue: { flex: 1, color: t.colors.textPrimary, ...t.foundation.typography.body },
    contextSource: { color: t.colors.textTertiary, ...t.foundation.typography.meta, marginLeft: 'auto', flexShrink: 1 },
    todayRow: {
      minHeight: t.foundation.hitTarget,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.spacing.sm,
      paddingVertical: t.spacing.sm,
    },
    check: { width: t.iconSize.standard, color: t.colors.accent, fontSize: t.iconSize.standard },
    todayBody: { flex: 1, gap: t.spacing.xxs },
    rowTitle: { color: t.colors.textPrimary, ...t.foundation.typography.cardTitle },
    meta: { color: t.colors.textTertiary, ...t.foundation.typography.meta },
    error: { color: t.colors.errorText, ...t.foundation.typography.meta },
  });
}

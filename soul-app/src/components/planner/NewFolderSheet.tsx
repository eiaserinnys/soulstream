import { usePersistentDraft } from '../../hooks/usePersistentDraft';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { Folder } from '../../api/types';
import type { PlannerFolder } from '../../api/plannerTypes';
import { operationId, type FolderCreationAttempt } from '../../api/plannerMutationPort';
import { ApiHttpError } from '../../api/clientCore';
import type { ApiClient } from '../../api/client';
import {
  emptyFolderSettingsDraft,
  folderSettingsDraftFromBlocks,
  formatExecutionDefaultsSummary,
  initialContextFromDraft,
  type FolderSettingsDraft,
} from '../../lib/folder-settings';
import type { FolderAtomReference } from '../../lib/folder-context';
import { plannerDescriptionText } from '../../lib/planner-description-blocks';
import { useTokens, type DesignTokens } from '../../theme';
import { AppModalSurface } from '../AppModalSurface';
import { AppKeyboardAvoidingView } from '../AppKeyboardAvoidingView';
import { buildNewFolderSubmission, projectOptionsFromFolders } from './newFolderCreation';
import { SheetErrorNotice, sheetErrorDetail } from './SheetErrorNotice';
import { PlannerAtomContextPicker, type PickedAtomReference } from './PlannerAtomContextPicker';
import { FolderSettingsForm, type FolderInheritedContext } from './FolderSettingsForm';
import type { FolderCreateInput, FolderSaveInput } from './folderSettingsActions';
import { useExecutionDefaultsNames, useFolderContextChain, usePageSessionDefaults } from './useFolderContext';
import {
  captureAuthScope,
  isAuthScopeCurrent,
  useAuthScopeGeneration,
} from '../../lib/auth-scope';

/** `create` takes the parent page (null for a top-level folder); `edit` opens the folder's own settings. */
export type FolderSheetTarget =
  | { kind: 'create'; parentProjectPageId: string | null }
  | { kind: 'edit'; folder: PlannerFolder };

type PickerState = null | { kind: 'add' } | { kind: 'edit'; index: number };

/** One sheet for new folders and folder settings; the confirm writes everything at once. */
export function NewFolderSheet({
  visible,
  api,
  folders,
  target,
  onClose,
  onSubmit,
  onSave,
}: {
  visible: boolean;
  api: ApiClient | null;
  folders: readonly Folder[];
  target: FolderSheetTarget;
  onClose(): void;
  onSubmit?(input: FolderCreateInput): Promise<unknown>;
  onSave?(input: FolderSaveInput): Promise<unknown>;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const options = useMemo(() => projectOptionsFromFolders(folders), [folders]);
  const scopeGeneration = useAuthScopeGeneration();
  const editFolder = target.kind === 'edit' ? target.folder : null;
  const draftTarget = [target.kind === 'create' ? target.parentProjectPageId ?? 'root' : `edit:${editFolder!.page.id}`];
  const descriptionDraft = usePersistentDraft('folder-create-description', draftTarget, '');
  const guidanceDraft = usePersistentDraft('folder-create-guidance', draftTarget, '');
  const ready = editFolder ? true : descriptionDraft.ready && guidanceDraft.ready;
  const [draft, setDraft] = useState<FolderSettingsDraft>(emptyFolderSettingsDraft);
  const [baseline, setBaseline] = useState<FolderSettingsDraft>(emptyFolderSettingsDraft);
  const [defaultsValid, setDefaultsValid] = useState(true);
  const [parentPageId, setParentPageId] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerState>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const completedRef = useRef(false);
  const submission = useRef<{ input: ReturnType<typeof buildNewFolderSubmission>; creation: FolderCreationAttempt; rejected?: boolean } | null>(null);
  const [retryingSnapshot, setRetryingSnapshot] = useState(false);
  const locked = submitting || retryingSnapshot;
  const wasVisible = useRef(false);
  const draftScopeGeneration = useRef(scopeGeneration);
  const opening = useRef({ target, folders });
  opening.current = { target, folders };

  useEffect(() => {
    const isOpening = visible && !wasVisible.current;
    const scopeChanged = draftScopeGeneration.current !== scopeGeneration;
    wasVisible.current = visible;
    draftScopeGeneration.current = scopeGeneration;
    if (!visible || (!isOpening && !scopeChanged)) return;
    const { target: openingTarget, folders: openingFolders } = opening.current;
    const initial = openingTarget.kind === 'edit'
      ? folderSettingsDraftFromBlocks({
        title: openingTarget.folder.page.title,
        description: plannerDescriptionText(openingTarget.folder.blocks),
        blocks: openingTarget.folder.blocks,
      })
      : emptyFolderSettingsDraft();
    submission.current = null;
    submittingRef.current = false;
    completedRef.current = false;
    setRetryingSnapshot(false);
    setDraft(initial);
    setBaseline(initial);
    setDefaultsValid(true);
    setParentPageId(openingTarget.kind === 'create'
      ? openingTarget.parentProjectPageId
      : openingFolders.find((folder) => folder.id === openingTarget.folder.parentFolderId)?.projectPageId ?? null);
    setPicker(null);
    setSubmitting(false);
    setError(null);
  }, [scopeGeneration, visible]);

  const ownsDraft = draftScopeGeneration.current === scopeGeneration;
  const visibleDraft: FolderSettingsDraft = !ownsDraft ? emptyFolderSettingsDraft() : editFolder ? draft : {
    ...draft,
    description: descriptionDraft.value,
    guidance: guidanceDraft.value,
    guidanceSource: draft.guidanceSource === 'own' || guidanceDraft.value.trim() ? 'own' : 'inherit',
  };
  const update = (patch: Partial<FolderSettingsDraft>) => {
    if (!editFolder && patch.description !== undefined) descriptionDraft.setValue(patch.description);
    if (!editFolder && patch.guidance !== undefined) guidanceDraft.setValue(patch.guidance);
    if (!editFolder && patch.guidanceSource === 'inherit') guidanceDraft.setValue('');
    setDraft((current) => ({ ...current, ...patch }));
  };

  const parentOption = parentPageId ? options.find((option) => option.projectPageId === parentPageId) ?? null : null;
  const parentFolder = parentPageId ? folders.find((folder) => folder.projectPageId === parentPageId) ?? null : null;
  const chain = useFolderContextChain(api, parentFolder?.id ?? null, folders, visible);
  const parentDefaults = usePageSessionDefaults(api, parentPageId, folders, visible);
  const defaultsNames = useExecutionDefaultsNames(api, parentDefaults.data?.defaults ?? null);
  const nearestGuidance = chain.data?.guidance ?? [];
  const inherited: FolderInheritedContext = {
    guidance: nearestGuidance.length > 0 ? {
      text: nearestGuidance.map((item) => item.text).join('\n\n'),
      sourceName: nearestGuidance[nearestGuidance.length - 1]!.source.folderName,
    } : null,
    references: chain.data?.atomReferences ?? [],
    defaults: parentDefaults.data ? {
      summary: formatExecutionDefaultsSummary(defaultsNames) || '…',
      sourceName: parentDefaults.data.sourceName,
    } : null,
    loading: chain.loading || parentDefaults.loading,
  };

  const pickProject = () => {
    const labels = [...options.map((option) => option.name), '취소'];
    ActionSheetIOS.showActionSheetWithOptions({
      title: '상위 폴더 선택',
      options: labels,
      cancelButtonIndex: labels.length - 1,
    }, (index) => {
      if (index < options.length) setParentPageId(options[index]!.projectPageId);
    });
  };

  const submit = async () => {
    if (!ready || submittingRef.current || completedRef.current) return;
    const scope = captureAuthScope();
    const submittedGeneration = scopeGeneration;
    const owns = () => isAuthScopeCurrent(scope) && draftScopeGeneration.current === submittedGeneration;
    setError(null);
    try {
      if (editFolder) {
        submittingRef.current = true;
        setSubmitting(true);
        await onSave?.({ folder: editFolder, baseline, draft: visibleDraft });
        if (owns()) { completedRef.current = true; onClose(); }
        return;
      }
      const candidate = buildNewFolderSubmission({
        title: visibleDraft.title,
        description: visibleDraft.description,
        parent: parentPageId === null ? null : parentOption ?? undefined,
        initialContext: initialContextFromDraft(visibleDraft),
      });
      if (submission.current?.rejected && JSON.stringify(submission.current.input) !== JSON.stringify(candidate)) submission.current = null;
      const input = submission.current?.input ?? candidate;
      submission.current ??= { input, creation: { idempotencyKey: operationId('folder-create') } };
      const attempt = submission.current;
      submittingRef.current = true;
      setSubmitting(true);
      await onSubmit?.({ ...attempt.input, creation: attempt.creation });
      if (owns()) {
        completedRef.current = true;
        descriptionDraft.clearIfMatches(input.description);
        guidanceDraft.clearIfMatches(guidanceDraft.value);
        onClose();
      }
    } catch (cause) {
      if (owns()) {
        // Explicit rejection may be edited; an unknown response keeps its original request.
        if (submission.current) {
          submission.current.rejected = !submission.current.creation.result
            && cause instanceof ApiHttpError && [400, 403, 404, 422].includes(cause.status);
        }
        setRetryingSnapshot(Boolean(submission.current && !submission.current.rejected));
        setError(sheetErrorDetail(cause));
      }
    } finally {
      if (owns()) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  };

  const requestClose = () => { if (!submittingRef.current) onClose(); };
  const defaultsReady = visibleDraft.defaultsSource === 'inherit' || defaultsValid;
  const parentReady = editFolder !== null || parentPageId === null || Boolean(parentOption);
  const canSubmit = Boolean(ready && visibleDraft.title.trim() && parentReady && defaultsReady && !submitting);
  const editingReference = picker?.kind === 'edit' ? visibleDraft.atomReferences[picker.index] ?? null : null;
  const pickReference = (picked: PickedAtomReference) => {
    const references = visibleDraft.atomReferences;
    if (picker?.kind === 'edit' && editingReference) {
      const next: FolderAtomReference = { ...editingReference, ...picked };
      update({ atomReferences: references.map((reference, index) => index === picker.index ? next : reference) });
      return;
    }
    const sameNode = (reference: FolderAtomReference) => reference.instance === picked.instance && reference.nodeId === picked.nodeId;
    const existing = references.find(sameNode);
    update({ atomReferences: existing
      ? references.map((reference) => sameNode(reference) ? { ...reference, ...picked } : reference)
      : [...references, { blockId: null, ...picked }] });
  };
  const title = editFolder ? '폴더 설정' : '새 폴더';
  const parentName = editFolder
    ? parentFolder?.name ?? null
    : parentPageId === null ? null : parentOption?.name ?? '상위 폴더 선택';
  return (
    <AppModalSurface
      visible={visible}
      variant="expanded"
      modalId="modal_new_task"
      presentationStyle="pageSheet"
      onRequestClose={() => picker ? setPicker(null) : requestClose()}
      safeAreaTestID="new-task-safe-area"
    >
      {picker ? (
        <PlannerAtomContextPicker
          visible
          api={api}
          initial={editingReference}
          onClose={() => setPicker(null)}
          onPicked={pickReference}
        />
      ) : <>
      <View testID="new-task-header" style={styles.header}>
        <TouchableOpacity testID="new-task-cancel" accessibilityRole="button" style={styles.headerButton} onPress={requestClose} disabled={submitting}>
          <Text style={styles.headerAction}>취소</Text>
        </TouchableOpacity>
        <Text testID="new-task-header-title" accessibilityRole="header" style={styles.headerTitle}>{title}</Text>
        <TouchableOpacity testID="new-task-submit" accessibilityRole="button" style={styles.headerButton} onPress={submit}
          disabled={!canSubmit} accessibilityState={{ disabled: !canSubmit }}>
          {submitting
            ? <ActivityIndicator color={t.colors.accent} />
            : <Text style={[styles.headerAction, !canSubmit && styles.disabled]}>{editFolder ? '저장' : '만들기'}</Text>}
        </TouchableOpacity>
      </View>
      <AppKeyboardAvoidingView testID="new-task-keyboard" style={styles.keyboard} behavior={Platform.OS === 'ios' ? 'height' : undefined}>
        <ScrollView testID="new-task-content" contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
          <FolderSettingsForm
            key={`${scopeGeneration}:${visible}`}
            api={api}
            mode={editFolder ? 'edit' : 'create'}
            parentName={parentName}
            onPickParent={editFolder || parentPageId === null ? undefined : pickProject}
            locked={locked || !ready}
            draft={visibleDraft}
            inherited={inherited}
            defaultsOpening={baseline.defaults}
            onChange={update}
            onDefaultsChange={(change) => {
              setDefaultsValid(change.valid);
              setDraft((current) => JSON.stringify(current.defaults) === JSON.stringify(change.value) ? current : { ...current, defaults: change.value });
            }}
            onAddReference={() => setPicker({ kind: 'add' })}
            onEditReference={(index) => setPicker({ kind: 'edit', index })}
          />
          {visibleDraft.defaultsSource === 'own' && !defaultsValid
            ? <Text style={styles.error} accessibilityRole="alert">노드와 에이전트를 고르고, 쓸 수 있는 모델을 정해 주세요.</Text>
            : null}
          {chain.error || parentDefaults.error
            ? <SheetErrorNotice summary="물려받는 값을 불러오지 못했습니다. 닫고 다시 열어 주세요." detail={chain.error ?? parentDefaults.error ?? ''} />
            : null}
          {retryingSnapshot ? <Text style={styles.meta}>이전 제출의 남은 저장을 다시 시도합니다. 폴더를 새로 만들지 않습니다.</Text> : null}
          {error ? <SheetErrorNotice summary="폴더를 저장하지 못했습니다. 입력을 유지했습니다. 다시 시도해 주세요." detail={error} /> : null}
        </ScrollView>
      </AppKeyboardAvoidingView>
      </>}
    </AppModalSurface>
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
    meta: { color: t.colors.textTertiary, ...t.foundation.typography.meta },
    error: { color: t.colors.errorText, ...t.foundation.typography.meta },
  });
}

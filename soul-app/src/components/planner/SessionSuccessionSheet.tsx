// Existing succession state/context flow remains together to preserve its UX;
// this card change extracts only the shared selection row. Broader splitting is separate work.
import { captureAuthScope, isAuthScopeCurrent } from '../../lib/auth-scope';
import { usePersistentDraft } from '../../hooks/usePersistentDraft';
import { SelectedModelPresetName } from '../sheets/SelectedModelPresetName';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { ApiClient } from '../../api/client';
import type { PlannerFolder } from '../../api/plannerTypes';
import { useChatAttachments } from '../../hooks/useChatAttachments';
import { pendingId } from '../../hooks/plannerActionModels';
import { usePlannerActions } from '../../hooks/usePlannerActions';
import { usePlannerPageDetail } from '../../hooks/usePlannerReads';
import { useNewSessionSelection } from '../sheets/useNewSessionSelection';
import {
  buildAgentActionSheet,
  buildModelPresetActionSheet,
  buildNodeActionSheet,
  resolveAgentActionSheetSelection,
  resolveModelPresetActionSheetSelection,
  resolveNodeActionSheetSelection,
} from '../sheets/newSessionSelection';
import { plannerContextChips } from '../../lib/planner-context-chips';
import { buildPlannerContextPresentation, type PlannerDefaultAssignment } from '../../lib/planner-context-presentation';
import { buildSessionInitiationPrompt } from '../../lib/session-initiation-prompt';
import { getSessionDisplayName } from '../../lib/session-display-name';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useTokens } from '../../theme';
import { AppModalSurface } from '../AppModalSurface';
import { AttachmentChips } from '../chat/AttachmentChips';
import { AttachmentPickerButton } from '../chat/AttachmentPickerButton';
import { makeStyles as makeChatStyles } from '../chat/ChatBody.styles';
import { SessionSuccessionErrorBoundary } from './SessionSuccessionErrorBoundary';
import { SessionSuccessionDiagnosticFallback } from './SessionSuccessionDiagnosticFallback';
import { SheetErrorNotice, sheetErrorDetail } from './SheetErrorNotice';
import { GroupedGlassSheet } from './GroupedGlassSheet';
import { SessionSelectionRow as SelectionRow } from './SessionSelectionRow';
import { GrowingMultilineInput } from './GrowingMultilineInput';
import {
  buildPlannerFolderContextItem,
  type SessionContextItem,
} from '../../lib/planner-session-context';
import { makeStyles } from './SessionSuccessionSheet.styles';
import {
  buildEffortActionSheet,
  effortRowValue,
  isEffortSupported,
  presetSupportsEffort,
  reasoningEffortForSubmit,
  resolveEffortActionSheetSelection,
} from '../sheets/reasoningEffort';

export const INITIAL_SESSION_PROMPT = '';

export interface SessionSuccessionSheetProps {
  api: ApiClient | null;
  folder: PlannerFolder;
  predecessorSessionId?: string | null;
  visible: boolean;
  onClose(): void;
  onCreated(sessionId: string): void;
}

export function SessionSuccessionSheet(props: SessionSuccessionSheetProps) {
  const { folder, visible } = props;
  return (
    <SessionSuccessionErrorBoundary
      resetKey={`${folder.page.id}:${visible ? 'open' : 'closed'}`}
      failureContext={{
        folderId: folder.folderId,
        folderPageId: folder.page.id,
        projectPageId: folder.projectPageId,
        visible,
        predecessorSessionId: props.predecessorSessionId ?? null,
        folderBlockCount: folder.blocks.length,
        folderSessionCount: folder.sessions.length,
      }}
      onEmergencyClose={props.onClose}
      renderFallback={(failure) => (
        <SessionSuccessionDiagnosticFallback
          {...props}
          predecessorSessionId={props.predecessorSessionId ?? null}
          failure={failure}
        />
      )}
    >
      <SessionSuccessionSheetContent {...props} />
    </SessionSuccessionErrorBoundary>
  );
}

function SessionSuccessionSheetContent({
  api,
  folder,
  predecessorSessionId,
  visible,
  onClose,
  onCreated,
}: SessionSuccessionSheetProps) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const chatStyles = useMemo(() => makeChatStyles(t), [t]);
  const actions = usePlannerActions(api);
  const settingsNodeId = useSettingsStore((state) => state.nodeId);
  const predecessor = resolveSessionPredecessor(folder, predecessorSessionId);
  const predecessorSession = useSessionStore((state) => (
    predecessor?.agentSessionId ? state.sessions[predecessor.agentSessionId] : undefined
  ));
  const projectContext = usePlannerPageDetail(
    api,
    folder.projectPageId,
    visible,
  );
  const assignment = buildPlannerContextPresentation({
    projectName: '프로젝트',
    projectBlocks: projectContext.data?.blocks ?? [],
    folderBlocks: folder.blocks,
  }).assignment;
  const assignmentDefaults = resolveSessionAssignmentDefaults(assignment, predecessor);
  const contextChips = useMemo(
    () => plannerContextChips(folder.blocks),
    [folder.blocks],
  );
  const [includeFolderContext, setIncludeFolderContext] = useState(true);
  const [inheritPredecessor, setInheritPredecessor] = useState(Boolean(predecessor));
  const instructionDraft = usePersistentDraft('session-succession', [predecessor?.agentSessionId ?? folder.folderId], INITIAL_SESSION_PROMPT);
  const { value: initialInstruction, setValue: setInitialInstruction } = instructionDraft;
  const [attachmentSessionId, setAttachmentSessionId] = useState(() => pendingId('attachment'));
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const submissionCompleted = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const submissionPending = useRef(false);
  const [executionExpanded, setExecutionExpanded] = useState(
    !assignmentDefaults.nodeId || !assignmentDefaults.agentId,
  );
  // null = follow the selected preset's advertised default.
  const [selectedEffort, setSelectedEffort] = useState<string | null>(
    assignmentDefaults.reasoningEffort,
  );
  const contentScrollRef = useRef<ScrollView | null>(null);
  const wasVisible = useRef(false);
  const openingPredecessor = useRef(predecessor);
  openingPredecessor.current = predecessor;
  const selection = useNewSessionSelection({
    visible,
    api,
    folders: [],
    settingsNodeId,
    defaultNodeId: assignmentDefaults.nodeId,
    defaultAgentId: assignmentDefaults.agentId,
    defaultModelPresetId: assignmentDefaults.modelPreset,
  });
  const {
    attachments,
    uploading,
    attachmentsReady,
    pickAttachment,
    removeAttachment,
    clearAttachments,
  } = useChatAttachments({
    api,
    sessionId: attachmentSessionId,
    nodeId: selection.effectiveNodeId ?? undefined,
    disabled: !visible || submitting || !selection.effectiveNodeId,
    reuploadOnNodeChange: true,
  });

  useEffect(() => {
    const opening = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (!opening) return;
    submissionCompleted.current = false;
    setSubmissionError(null);
    setIncludeFolderContext(true);
    setInheritPredecessor(Boolean(openingPredecessor.current));
    setAttachmentSessionId(pendingId('attachment'));
    clearAttachments();
  }, [clearAttachments, visible]);

  useEffect(() => {
    clearAttachments();
  }, [api, clearAttachments]);

  const contextSelection = buildSuccessionContextSelection({
    folder,
    includeFolderContext,
  });

  const pickNode = () => {
    if (submissionPending.current) return;
    const sheet = buildNodeActionSheet(selection.nodes);
    ActionSheetIOS.showActionSheetWithOptions(sheet, (index) => {
      if (submissionPending.current) return;
      const result = resolveNodeActionSheetSelection(
        index,
        selection.nodes,
        sheet.cancelButtonIndex,
      );
      if (!result.cancelled) selection.setSelectedNodeId(result.nodeId);
    });
  };

  const pickAgent = () => {
    if (submissionPending.current) return;
    const sheet = buildAgentActionSheet(selection.agents);
    ActionSheetIOS.showActionSheetWithOptions(sheet, (index) => {
      if (submissionPending.current) return;
      const result = resolveAgentActionSheetSelection(
        index,
        selection.agents,
        sheet.cancelButtonIndex,
      );
      if (!result.cancelled) selection.setAgentId(result.agentId);
    });
  };

  const effortPreset = selection.effectiveModelPreset;
  // node + preset: two nodes can advertise the same preset id with different
  // defaults, and a catalogue refresh for the same pair is not a switch.
  // A carried-over value this preset cannot run must be resolved deliberately —
  // either a different level or an explicit "기본값 사용" — never dropped at
  // submit: the row would keep showing a level the session never uses. While the
  // catalogue is still loading `effortPreset` is null and nothing is claimed.
  const effortUnsupported = !isEffortSupported(effortPreset, selectedEffort);
  const effortPresetKey = selection.effectiveModelPresetId
    ? `${selection.effectiveNodeId ?? ''}::${selection.effectiveModelPresetId}`
    : null;
  const lastEffortPresetKey = useRef(effortPresetKey);

  // Keyed on the preset *id*, not the loaded preset object, for two reasons:
  //  - changing model or node must adopt the new preset's default even when the
  //    previous pick is also legal there, and even when two nodes advertise the
  //    same preset id with different defaults;
  //  - the id is known synchronously while the catalog request is still in
  //    flight, so an inherited value cannot be wiped before the presets arrive.
  useEffect(() => {
    if (lastEffortPresetKey.current === effortPresetKey) return;
    lastEffortPresetKey.current = effortPresetKey;
    setSelectedEffort(null);
  }, [effortPresetKey]);

  // Reopening for a different predecessor must not keep the previous sheet's
  // pick; the selection hook resets node/agent/model the same way.
  useEffect(() => {
    if (!visible) return;
    lastEffortPresetKey.current = effortPresetKey;
    setSelectedEffort(assignmentDefaults.reasoningEffort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const pickEffort = useCallback(() => {
    if (submissionPending.current) return;
    const sheet = buildEffortActionSheet(effortPreset);
    ActionSheetIOS.showActionSheetWithOptions(
      { options: sheet.options, cancelButtonIndex: sheet.cancelButtonIndex, title: sheet.title },
      (index) => {
        if (submissionPending.current) return;
        const picked = resolveEffortActionSheetSelection(effortPreset, index);
        if (picked === undefined) return;
        setSelectedEffort(picked);
      },
    );
  }, [effortPreset]);

  const pickModel = () => {
    if (submissionPending.current) return;
    const sheet = buildModelPresetActionSheet(selection.modelPresets);
    ActionSheetIOS.showActionSheetWithOptions(sheet, (index) => {
      if (submissionPending.current) return;
      const result = resolveModelPresetActionSheetSelection(
        index,
        selection.modelPresets,
        sheet.cancelButtonIndex,
      );
      if (!result.cancelled) {
        selection.setSelectedModelPresetId(result.modelPresetId);
      }
    });
  };

  const submit = async () => {
    if (
      submissionPending.current
      || submissionCompleted.current
      || !attachmentsReady
      || !instructionDraft.ready
      || !selection.effectiveNodeId
      || !selection.agentId
      || selection.modelPresetSelectionInvalid
      || effortUnsupported
    ) return;
    const scope = captureAuthScope();
    submissionPending.current = true;
    setSubmissionError(null);
    setSubmitting(true);
    try {
      const response = await actions.createFolderSession({
        folder: folder,
        prompt: buildSessionInitiationPrompt(initialInstruction),
        nodeId: selection.effectiveNodeId,
        agentId: selection.agentId,
        ...(selection.selectedModelPresetId
          ? { modelPreset: selection.selectedModelPresetId }
          : {}),
        ...(reasoningEffortForSubmit(effortPreset, selectedEffort)
          ? { reasoningEffort: reasoningEffortForSubmit(effortPreset, selectedEffort)! }
          : {}),
        ...(inheritPredecessor && predecessor?.agentSessionId
          ? { predecessorSessionId: predecessor.agentSessionId }
          : {}),
        needsPageAnchor: contextSelection.needsPageAnchor,
        extraContextItems: contextSelection.contextItems,
        ...(attachments.length > 0
          ? { attachmentPaths: attachments.map((attachment) => attachment.path) }
          : {}),
      });
      if (!isAuthScopeCurrent(scope)) return;
      if (!response.agentSessionId) throw new Error('세션 생성 응답에 ID가 없습니다.');
      submissionCompleted.current = true;
      instructionDraft.clearIfMatches(initialInstruction);
      onCreated(response.agentSessionId);
      closeSheet();
    } catch (error) {
      if (isAuthScopeCurrent(scope)) setSubmissionError(sheetErrorDetail(error));
    } finally {
      submissionPending.current = false;
      setSubmitting(false);
    }
  };

  const closeSheet = () => {
    clearAttachments();
    onClose();
  };
  const requestClose = () => {
    if (!submitting && !submissionPending.current) closeSheet();
  };
  const canSubmit = Boolean(
    instructionDraft.ready && selection.effectiveNodeId
      && selection.agentId
      && !selection.modelPresetSelectionInvalid
      && !effortUnsupported
      && !submitting
      && attachmentsReady,
  );
  const executionNeedsAttention = !selection.effectiveNodeId || !selection.agentId
    || selection.modelPresetSelectionInvalid || (effortUnsupported && effortPreset !== null);
  const showExecution = executionExpanded || executionNeedsAttention;
  useEffect(() => {
    // Keep the resolved choice in view after correcting an invalid selection.
    if (executionNeedsAttention) setExecutionExpanded(true);
  }, [executionNeedsAttention]);
  return (
    <AppModalSurface
      visible={visible}
      variant="expanded"
      modalId="modal_session_succession"
      presentationStyle="pageSheet"
      onRequestClose={requestClose}
      safeAreaTestID="succession-safe-area"
    >
      <View testID="succession-header" style={styles.header}>
            <TouchableOpacity accessibilityLabel="세션 작성 취소" style={styles.headerButton} onPress={requestClose} disabled={submitting}><Text style={[styles.headerAction, submitting && styles.disabled]}>취소</Text></TouchableOpacity>
            <Text testID="succession-header-title" style={styles.title}>새 세션</Text>
            <TouchableOpacity testID="succession-submit" accessibilityLabel="세션 시작" style={styles.headerButton} onPress={submit} disabled={!canSubmit}>
              {submitting
                ? <ActivityIndicator color={t.colors.accent} />
                : <Text style={[styles.headerAction, !canSubmit && styles.disabled]}>세션 시작</Text>}
            </TouchableOpacity>
      </View>
      <View testID="succession-keyboard" style={styles.keyboard}>
        <ScrollView
          ref={contentScrollRef}
          testID="succession-content"
          contentContainerStyle={styles.content}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        >
          <View style={styles.section} testID="succession-folder-scope">
            <Text style={styles.meta}>세션을 시작할 폴더</Text>
            <Text style={styles.folderTitle}>{folder.page.title}</Text>
            {submissionError ? <SheetErrorNotice summary="세션을 시작하지 못했습니다. 초기 지시는 유지했습니다. 응답을 받지 못한 경우 세션 목록에서 결과를 확인해 주세요." detail={submissionError} /> : null}
          <Text style={styles.purpose}>선택한 실행 대상이 이 폴더에서 바로 작업을 시작합니다.</Text>
          </View>

          <View style={styles.section} testID="succession-request-section">
            <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>초기 지시</Text><Text style={styles.required}>선택</Text></View>
            <GroupedGlassSheet testID="succession-initial-instruction-group">
              <View style={styles.formField}>
                <AttachmentChips
                  attachments={attachments}
                  styles={chatStyles}
                  textSecondaryColor={t.colors.textSecondary}
                  textMutedColor={t.colors.textMuted}
                  onRemove={removeAttachment}
                  disabled={submitting}
                />
                <View style={styles.initialComposerRow}>
                  <AttachmentPickerButton
                    testID="succession-attachment-button"
                    surfaceTestID="succession-attachment-visual"
                    uploading={uploading}
                    disabled={submitting || !selection.effectiveNodeId}
                    onPress={pickAttachment}
                  />
                  <GrowingMultilineInput editable={instructionDraft.ready && !submitting}
                    testID="succession-initial-instruction"
                    value={initialInstruction}
                    onChangeText={setInitialInstruction}
                    outerScrollRef={contentScrollRef}
                    minHeight={t.foundation.minHeight.memo}
                    maxHeight={t.foundation.minHeight.memo * 2}
                    verticalPadding={t.spacing.sm}
                    placeholder="세션을 시작하자마자 수행할 지시…"
                    placeholderTextColor={t.colors.textPlaceholder}
                    style={styles.initialInput}
                  />
                </View>
              </View>
            </GroupedGlassSheet>
          </View>

          <GroupedGlassSheet testID="succession-selection-group">
            <TouchableOpacity testID="succession-execution-disclosure" style={styles.disclosure}
              accessibilityRole="button" accessibilityLabel="실행 설정"
              accessibilityState={{ expanded: showExecution }} disabled={submitting || executionNeedsAttention}
              onPress={() => setExecutionExpanded(current => !current)}>
              <View style={styles.disclosureBody}>
                <Text style={styles.rowTitle}>실행 대상</Text>
                <Text style={styles.meta}>{selection.selectedAgentName}, {selection.selectedNodeName}</Text>
                <Text style={styles.meta}><SelectedModelPresetName selection={selection} />{presetSupportsEffort(effortPreset) ? `, ${effortRowValue(effortPreset, selectedEffort)}` : ''}</Text>
              </View>
              <Text style={styles.disclosureAction}>{executionNeedsAttention ? '확인 필요' : showExecution ? '접기 ⌃' : '변경 ⌄'}</Text>
            </TouchableOpacity>
            {showExecution ? <View testID="succession-execution-details" style={styles.disclosureDetails}>
            {!selection.effectiveNodeId || !selection.agentId ? <Text style={styles.selectionError}>노드와 에이전트를 선택해 주세요.</Text> : null}
            <SelectionRow disabled={submitting} testID="succession-selection-node" label="노드" value={selection.selectedNodeName} onPress={pickNode} styles={styles} />
            <SelectionRow disabled={submitting} testID="succession-selection-agent" label="에이전트" value={selection.selectedAgentName} onPress={pickAgent} styles={styles} />
            <SelectionRow disabled={submitting} testID="succession-selection-model" label="모델" value={<SelectedModelPresetName selection={selection} />} onPress={pickModel} styles={styles} />
            {presetSupportsEffort(effortPreset) ? (
              <SelectionRow
                testID="succession-selection-effort"
                disabled={submitting}
                label="추론 강도"
                value={effortRowValue(effortPreset, selectedEffort)}
                onPress={pickEffort}
                styles={styles}
              />
            ) : null}
            {effortUnsupported && effortPreset !== null ? (
              <>
                <Text style={styles.selectionError} accessibilityRole="alert">
                  {presetSupportsEffort(effortPreset)
                    ? '이어받은 추론 강도를 이 모델에서는 쓸 수 없습니다. 다른 강도를 고르거나 기본값으로 시작하세요.'
                    : '이 모델이 광고한 추론 강도 목록이 없어 이어받은 값을 그대로 쓸 수 없습니다. 기본값으로 시작하세요.'}
                </Text>
                <SelectionRow
                  testID="succession-effort-use-default"
                  disabled={submitting}
                  label="이어받은 추론 강도"
                  value="기본값 사용"
                  onPress={() => { if (!submissionPending.current) setSelectedEffort(null); }}
                  styles={styles}
                />
              </>
            ) : null}
            {selection.selectedModelPresetUsageWarning ? (
              <Text style={styles.warningBadge}>사용량 확인 지연</Text>
            ) : null}
            {selection.modelPresetSelectionInvalid ? (
              <Text style={styles.selectionError} accessibilityRole="alert">
                선택한 모델을 이 노드에서 사용할 수 없습니다. 모델을 다시 선택해 주세요.
              </Text>
            ) : null}
            </View> : null}
          </GroupedGlassSheet>

          <Text style={styles.sectionTitle}>함께 가져갈 컨텍스트</Text>
          <GroupedGlassSheet testID="succession-context-group">
            <CheckRow
              disabled={submitting}
              checked={includeFolderContext}
              testID="succession-check-task-context"
              label="폴더 본문과 컨텍스트"
              detail={contextChips.map((chip) => `${chip.icon} ${chip.label}`).join(' · ') || '연결된 컨텍스트 없음'}
              onPress={() => { if (!submissionPending.current) setIncludeFolderContext((current) => !current); }}
              styles={styles}
            />
            {predecessor ? (
              <CheckRow
                disabled={submitting}
                checked={inheritPredecessor}
                label="이전 세션"
                detail={getSessionDisplayName(predecessorSession, predecessor.agentSessionId)}
                onPress={() => { if (!submissionPending.current) setInheritPredecessor((current) => !current); }}
                styles={styles}
              />
            ) : null}
          </GroupedGlassSheet>

        </ScrollView>
      </View>
    </AppModalSurface>
  );
}

export function buildSuccessionContextSelection({
  folder,
  includeFolderContext,
}: {
  folder: PlannerFolder;
  includeFolderContext: boolean;
}): { needsPageAnchor: boolean; contextItems: SessionContextItem[] } {
  const contextItems: SessionContextItem[] = [];
  if (includeFolderContext) {
    contextItems.push(buildPlannerFolderContextItem(folder));
  }
  return { needsPageAnchor: includeFolderContext, contextItems };
}

export function resolveSessionPredecessor(
  folder: PlannerFolder,
  predecessorSessionId: string | null | undefined,
) {
  if (typeof predecessorSessionId !== 'string') return undefined;
  return folder.sessions.find((session) => session.agentSessionId === predecessorSessionId);
}

export function resolveSessionAssignmentDefaults(
  assignment: Pick<PlannerDefaultAssignment, 'agentId' | 'nodeId' | 'modelPreset'> | null,
  predecessor: {
    agentId?: string | null;
    nodeId?: string | null;
    modelPreset?: string | null;
    reasoningEffort?: string | null;
  } | undefined,
): {
  agentId: string | null;
  nodeId: string | null;
  modelPreset: string | null;
  reasoningEffort: string | null;
} {
  return {
    agentId: assignment?.agentId ?? predecessor?.agentId ?? null,
    nodeId: assignment?.nodeId ?? predecessor?.nodeId ?? null,
    modelPreset: assignment?.modelPreset ?? predecessor?.modelPreset ?? null,
    // Page defaults carry no effort, so it is inherited from the predecessor
    // session alone. Dropping it would rerun the successor at the preset default.
    reasoningEffort: predecessor?.reasoningEffort ?? null,
  };
}

function CheckRow({ testID, checked, label, detail, onPress, styles, disabled }: {
  testID?: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  detail?: string;
  onPress(): void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <TouchableOpacity testID={testID} style={styles.checkRow} onPress={onPress} disabled={disabled} accessibilityRole="checkbox" accessibilityState={{ checked, disabled }}>
      <Text style={styles.check}>{checked ? '✓' : '○'}</Text>
      <View style={styles.checkBody}>
        <Text style={styles.rowTitle}>{label}</Text>
        {detail ? <Text style={styles.meta} numberOfLines={2}>{detail}</Text> : null}
      </View>
    </TouchableOpacity>
  );
}

import React, { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { ApiHttpError } from '../../api/clientCore';
import type { ApiClient } from '../../api/client';
import type { CardAssignment } from '../../api/cardTypes';
import { cardOperationId, useCardActions } from '../../hooks/useCardActions';
import { useChatAttachments } from '../../hooks/useChatAttachments';
import { usePersistentDraft } from '../../hooks/usePersistentDraft';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useTokens } from '../../theme';
import { AppModalSurface } from '../AppModalSurface';
import { AttachmentChips } from '../chat/AttachmentChips';
import { AttachmentPickerButton } from '../chat/AttachmentPickerButton';
import { makeStyles as makeChatStyles } from '../chat/ChatBody.styles';
import { GrowingMultilineInput } from './GrowingMultilineInput';
import { useNewSessionSelection } from '../sheets/useNewSessionSelection';
import { cardFiles } from '../../lib/card-files';
import { SheetErrorNotice, sheetErrorDetail } from './SheetErrorNotice';
import { CardRequestView } from './CardRequestView';
import { ExecutionSelectionSheet } from './ExecutionSelectionSheet';
import { FolderSelectionSheet } from './FolderSelectionSheet';
import { GroupedGlassSheet } from './GroupedGlassSheet';
import { SessionSelectionRow } from './SessionSelectionRow';
import { SelectedModelPresetName } from '../sheets/SelectedModelPresetName';
import { makeStyles } from './SessionSuccessionSheet.styles';

export function CardCreateSheet({ api, onClose, folderId: initialFolderId }: { api: ApiClient | null; onClose(): void; folderId?: string }) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const chat = useMemo(() => makeChatStyles(t), [t]);
  const settings = useSettingsStore();
  const remembered = settings.cardAssignments[settings.serverUrl];
  const folders = useSessionStore((state) => state.catalog.folders);
  const [folderId, setFolderId] = useState(initialFolderId ?? remembered?.folderId ?? '');
  const [execution, setExecution] = useState<CardAssignment>(() => ({ folderId: initialFolderId ?? remembered?.folderId ?? '',
    nodeId: remembered?.nodeId ?? settings.nodeId, agentId: remembered?.agentId ?? null, modelPreset: remembered?.modelPreset ?? null }));
  const selection = useNewSessionSelection({ visible: true, api, folders, settingsNodeId: settings.nodeId,
    defaultNodeId: execution.nodeId, defaultAgentId: execution.agentId,
    // Mirror the confirmed picker defaults; the picker owns node transitions.
    defaultModelPresetId: execution.modelPreset });
  const assignment = { folderId, nodeId: selection.effectiveNodeId ?? null, agentId: selection.agentId, modelPreset: selection.effectiveModelPresetId };
  const [title, setTitle] = useState('');
  const draft = usePersistentDraft('card-request', [initialFolderId ?? 'all'], '');
  const { value: request, setValue: setRequest } = draft;
  const [selecting, setSelecting] = useState<'folder' | 'execution' | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const { run, pending } = useCardActions(api, cause => setErrorDetail(sheetErrorDetail(cause)));
  const saving = useRef(false);
  const completed = useRef(false);
  const submission = useRef<{ payload: Parameters<ApiClient['createCard']>[0]; assignment: CardAssignment; rejected?: boolean } | null>(null);
  const [retryingSnapshot, setRetryingSnapshot] = useState(false);
  const locked = pending || retryingSnapshot;
  const [uploadId] = useState(() => Crypto.randomUUID());
  const files = useChatAttachments({ api, sessionId: uploadId, nodeId: selection.effectiveNodeId ?? undefined,
    disabled: locked, reuploadOnNodeChange: true });
  const scroll = useRef<ScrollView>(null);
  const canSave = !!api && draft.ready && !pending && files.attachmentsReady && !!folderId
    && !!title.trim() && !!request.trim() && !!selection.effectiveNodeId && !!selection.agentId
    && !selection.modelPresetSelectionInvalid;
  const save = async () => {
    if (!api || !canSave || saving.current || completed.current) return;
    saving.current = true;
    setErrorDetail(null);
    const candidate = { folderId, title: title.trim(), request, queue: false,
      nodeId: assignment.nodeId, assignee: { kind: 'agent' as const, agentId: assignment.agentId! }, modelPreset: assignment.modelPreset,
      attachments: cardFiles(files.attachments) };
    const previous = submission.current;
    const { idempotencyKey: _key, ...previousPayload } = previous?.payload ?? {};
    const reuse = previous && (!previous.rejected || JSON.stringify(previousPayload) === JSON.stringify(candidate));
    const attempt = reuse ? previous : { assignment, payload: { ...candidate, idempotencyKey: cardOperationId() }, rejected: false };
    submission.current = attempt;
    try {
      if (await run(async () => {
        try { return await api.createCard(attempt.payload); }
        catch (cause) {
          attempt.rejected = cause instanceof ApiHttpError && [400, 403, 404, 422].includes(cause.status);
          setRetryingSnapshot(!attempt.rejected);
          throw cause;
        }
      })) {
        completed.current = true;
        settings.setCardAssignment(settings.serverUrl, attempt.assignment);
        draft.clearIfMatches(attempt.payload.request ?? ''); files.clearAttachments(); onClose();
      }
    } finally {
      saving.current = false;
    }
  };
  const requestClose = () => { if (!pending && !saving.current) onClose(); };
  return <>
    <AppModalSurface visible={!selecting} modalId="modal_card_assignment" variant="expanded" presentationStyle="pageSheet" onRequestClose={requestClose}>
      <View testID="card-create-header" style={styles.header}>
        <TouchableOpacity accessibilityLabel="카드 작성 취소" style={styles.headerButton} onPress={requestClose} disabled={pending}><Text style={[styles.headerAction, pending && styles.disabled]}>취소</Text></TouchableOpacity>
        <Text style={styles.title}>새 카드</Text>
        <TouchableOpacity accessibilityLabel="카드 저장" style={styles.headerButton} disabled={!canSave} onPress={() => { void save(); }}>
          {pending ? <ActivityIndicator color={t.colors.accent} /> : <Text style={[styles.headerAction, !canSave && styles.disabled]}>드래프트 저장</Text>}
        </TouchableOpacity>
      </View>
      <View style={styles.keyboard}>
        <ScrollView ref={scroll} testID="card-create-content" contentContainerStyle={styles.content}
          keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}>
          {errorDetail ? <SheetErrorNotice summary="카드를 저장하지 못했습니다. 입력을 유지했습니다. 다시 저장해 주세요." detail={errorDetail} /> : null}
          {retryingSnapshot ? <Text style={styles.purpose}>저장 결과를 확인하지 못했습니다. 같은 내용으로 다시 저장하여 결과를 확인합니다.</Text> : null}
          <Text style={styles.purpose}>할 일을 드래프트로 저장합니다. 실행은 대기열에 넣은 뒤 시작됩니다.</Text>
          <GroupedGlassSheet>
            <SessionSelectionRow label="저장할 폴더" value={folders.find((folder) => folder.id === folderId)?.name ?? '폴더 선택'}
              accessibilityLabel="카드 폴더 선택" styles={styles} disabled={locked || files.uploading} onPress={() => setSelecting('folder')} />
          </GroupedGlassSheet>
          <View style={styles.section} testID="card-create-title-section">
            <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>카드 제목</Text><Text style={styles.required}>필수</Text></View>
            <GroupedGlassSheet><View style={styles.formField}>
              <TextInput accessibilityLabel="카드 제목" placeholder="제목" value={title} onChangeText={setTitle}
                style={[styles.initialInput, { minHeight: t.foundation.minHeight.field, textAlignVertical: 'center' }]}
                placeholderTextColor={t.colors.textPlaceholder} editable={!locked} />
          </View></GroupedGlassSheet>
          </View>
          <View style={styles.section} testID="card-create-request-section">
            <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>요청</Text><Text style={styles.required}>필수</Text></View>
            <GroupedGlassSheet><View style={styles.formField}>
              <AttachmentChips attachments={files.attachments} onRemove={files.removeAttachment} disabled={locked}
                styles={chat} textSecondaryColor={t.colors.textSecondary} textMutedColor={t.colors.textMuted} />
              <GrowingMultilineInput accessibilityLabel="요청 원문" placeholder="요청 원문" value={request} onChangeText={setRequest}
                style={styles.initialInput} outerScrollRef={scroll} minHeight={t.foundation.minHeight.memo}
                maxHeight={t.foundation.minHeight.memo * 2} verticalPadding={t.spacing.sm}
                placeholderTextColor={t.colors.textPlaceholder} editable={!locked && draft.ready} />
              <CardRequestView request="" attachments={cardFiles(files.attachments.filter((file) => !!file.path))} />
              {files.error && files.attachments.length ? <SheetErrorNotice summary="첨부를 올리지 못했습니다. 제거하거나 다시 선택해 주세요." detail={files.error} /> : null}
              <AttachmentPickerButton uploading={files.uploading} disabled={locked || !selection.effectiveNodeId} onPress={files.pickAttachment} />
              {!selection.effectiveNodeId ? <Text style={styles.meta}>파일을 첨부하려면 실행 노드를 선택해 주세요.</Text> : null}
          </View></GroupedGlassSheet>
          </View>
          <GroupedGlassSheet testID="card-create-execution-group">
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="실행 대상 선택"
              accessibilityHint="노드, 에이전트와 모델을 선택합니다" style={styles.disclosure}
              disabled={locked || files.uploading} onPress={() => setSelecting('execution')}>
              <View style={styles.disclosureBody}>
                <Text style={styles.rowTitle}>실행 대상</Text>
                <Text style={styles.meta}>{selection.selectedAgentName}, {selection.selectedNodeName}</Text>
                <Text style={styles.meta}><SelectedModelPresetName selection={selection} /></Text>
              </View>
              <Text style={styles.disclosureAction}>변경 ›</Text>
            </TouchableOpacity>
            {!selection.effectiveNodeId || !selection.agentId ? <Text style={styles.selectionError} accessibilityRole="alert">저장하려면 노드와 에이전트를 선택해 주세요.</Text> : null}
            {selection.modelPresetSelectionInvalid ? <Text style={styles.selectionError} accessibilityRole="alert">선택한 모델을 이 노드에서 사용할 수 없습니다. 모델을 다시 선택해 주세요.</Text> : null}
          </GroupedGlassSheet>
        </ScrollView>
      </View>
    </AppModalSurface>
    {selecting === 'folder' ? <FolderSelectionSheet api={api} onClose={() => setSelecting(null)} onSelect={setFolderId} /> : null}
    {selecting === 'execution' ? <ExecutionSelectionSheet api={api} value={assignment} onClose={() => setSelecting(null)} onSave={(next) => {
      setExecution(next);
    }} /> : null}
  </>;
}

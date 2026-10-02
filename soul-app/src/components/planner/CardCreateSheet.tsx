import React, { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Crypto from 'expo-crypto';
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
import { CardRequestView } from './CardRequestView';
import { ExecutionSelectionSheet } from './ExecutionSelectionSheet';
import { FolderSelectionSheet } from './FolderSelectionSheet';
import { GroupedGlassSheet } from './GroupedGlassSheet';
import { SessionSelectionRow } from './SessionSelectionRow';
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
  const { run, pending } = useCardActions(api);
  const [uploadId] = useState(() => Crypto.randomUUID());
  const files = useChatAttachments({ api, sessionId: uploadId, nodeId: selection.effectiveNodeId ?? undefined,
    disabled: pending, reuploadOnNodeChange: true });
  const scroll = useRef<ScrollView>(null);
  const canSave = !!api && draft.ready && !pending && files.attachmentsReady && !!folderId
    && !!title.trim() && !!request.trim() && !!selection.effectiveNodeId && !!selection.agentId
    && !selection.modelPresetSelectionInvalid;
  const save = async () => {
    if (!api || !canSave) return;
    if (await run(() => api.createCard({ folderId, title: title.trim(), request, queue: false,
      nodeId: assignment.nodeId, assignee: { kind: 'agent', agentId: assignment.agentId! }, modelPreset: assignment.modelPreset,
      attachments: cardFiles(files.attachments), idempotencyKey: cardOperationId() }))) {
      settings.setCardAssignment(settings.serverUrl, assignment);
      draft.clearIfMatches(request); files.clearAttachments(); onClose();
    }
  };
  return <>
    <AppModalSurface visible={!selecting} modalId="modal_card_assignment" variant="expanded" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View testID="card-create-header" style={styles.header}>
        <TouchableOpacity accessibilityLabel="카드 작성 취소" style={styles.headerButton} onPress={onClose} disabled={pending}><Text style={styles.headerAction}>취소</Text></TouchableOpacity>
        <Text style={styles.title}>새 카드</Text>
        <TouchableOpacity accessibilityLabel="카드 저장" style={styles.headerButton} disabled={!canSave} onPress={() => { void save(); }}>
          {pending ? <ActivityIndicator color={t.colors.accent} /> : <Text style={[styles.headerAction, !canSave && styles.disabled]}>저장</Text>}
        </TouchableOpacity>
      </View>
      <View style={styles.keyboard}>
        <ScrollView ref={scroll} testID="card-create-content" contentContainerStyle={styles.content}
          keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}>
          <Text style={styles.sectionTitle}>카드 제목</Text>
          <GroupedGlassSheet><View style={styles.formField}>
            <TextInput accessibilityLabel="카드 제목" placeholder="제목" value={title} onChangeText={setTitle}
              style={[styles.initialInput, { minHeight: t.foundation.minHeight.field, textAlignVertical: 'center' }]}
              placeholderTextColor={t.colors.textPlaceholder} editable={!pending} />
          </View></GroupedGlassSheet>
          <Text style={styles.sectionTitle}>요청</Text>
          <GroupedGlassSheet><View style={styles.formField}>
            <GrowingMultilineInput accessibilityLabel="요청 원문" placeholder="요청 원문" value={request} onChangeText={setRequest}
              style={styles.initialInput} outerScrollRef={scroll} minHeight={t.foundation.minHeight.memo}
              maxHeight={t.foundation.minHeight.memo * 2} verticalPadding={t.spacing.sm}
              placeholderTextColor={t.colors.textPlaceholder} editable={!pending && draft.ready} />
          </View></GroupedGlassSheet>
          <Text style={styles.sectionTitle}>폴더 / 실행 대상</Text>
          <GroupedGlassSheet>
            <SessionSelectionRow label="폴더" value={folders.find((folder) => folder.id === folderId)?.name ?? '폴더 선택'}
              accessibilityLabel="카드 폴더 선택" styles={styles} disabled={pending || files.uploading} onPress={() => setSelecting('folder')} />
            <SessionSelectionRow label="노드" value={selection.selectedNodeName}
              accessibilityLabel="실행 대상 선택" styles={styles} disabled={pending || files.uploading} onPress={() => setSelecting('execution')} />
            <SessionSelectionRow label="에이전트" value={selection.selectedAgentName}
              accessibilityLabel="에이전트 선택" styles={styles} disabled={pending || files.uploading} onPress={() => setSelecting('execution')} />
            <SessionSelectionRow label="모델" value={selection.selectedModelPresetName}
              accessibilityLabel="모델 선택" styles={styles} disabled={pending || files.uploading} onPress={() => setSelecting('execution')} />
          </GroupedGlassSheet>
          {selection.modelPresetSelectionInvalid ? <Text style={styles.selectionError} accessibilityRole="alert">선택한 모델을 이 노드에서 사용할 수 없습니다. 모델을 다시 선택해 주세요.</Text> : null}
          <Text style={styles.sectionTitle}>첨부</Text>
          <GroupedGlassSheet><View style={styles.formField}>
            <AttachmentChips attachments={files.attachments} onRemove={files.removeAttachment} disabled={pending}
              styles={chat} textSecondaryColor={t.colors.textSecondary} textMutedColor={t.colors.textMuted} />
            <CardRequestView request="" attachments={cardFiles(files.attachments.filter((file) => !!file.path))} />
            {files.error && files.attachments.length ? <Text style={styles.selectionError} accessibilityRole="alert">{files.error} · 첨부를 제거하거나 다시 선택해 주세요.</Text> : null}
            <AttachmentPickerButton uploading={files.uploading} disabled={pending || !selection.effectiveNodeId} onPress={files.pickAttachment} />
          </View></GroupedGlassSheet>
        </ScrollView>
      </View>
    </AppModalSurface>
    {selecting === 'folder' ? <FolderSelectionSheet api={api} onClose={() => setSelecting(null)} onSelect={setFolderId} /> : null}
    {selecting === 'execution' ? <ExecutionSelectionSheet api={api} value={assignment} onClose={() => setSelecting(null)} onSave={(next) => {
      setExecution(next);
    }} /> : null}
  </>;
}

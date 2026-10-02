import { usePersistentDraft } from '../../hooks/usePersistentDraft';
import React, { useMemo, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import type { ApiClient } from '../../api/client';
import type { CardAssignment } from '../../api/cardTypes';
import { useSettingsStore } from '../../store/settingsStore';
import { useSessionStore } from '../../store/sessionStore';
import { useChatStore } from '../../store/chatStore';
import { captureAuthScope } from '../../lib/auth-scope';
import { useUIStore } from '../../store/uiStore';
import { buildNewSessionCreatePayload, commitNewSessionCreation } from '../sheets/newSessionSubmit';
import { useChatAttachments } from '../../hooks/useChatAttachments';

import { useTokens } from '../../theme';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { ChatComposer } from '../chat/ChatComposer';
import { AttachmentChips } from '../chat/AttachmentChips';
import { makeStyles as chatStyles } from '../chat/ChatBody.styles';
import { useNewSessionSelection } from '../sheets/useNewSessionSelection';
import { PlannerForegroundCard } from './PlannerForegroundCard';
import { FolderSelectionSheet } from './FolderSelectionSheet';
import { ExecutionSelectionSheet } from './ExecutionSelectionSheet';
import { todayCardStyles } from './TodayCard.styles';

export function TodayCardComposer({ api, onCreated }: { api: ApiClient | null; onCreated?(sessionId: string): void }) {
  const t = useTokens();
  const styles = useMemo(() => todayCardStyles(t), [t]);
  const chat = useMemo(() => chatStyles(t), [t]);
  const settings = useSettingsStore();
  const folders = useSessionStore((state) => state.catalog.folders);
  const remembered = settings.cardAssignments[settings.serverUrl];
  const [assignment, setAssignment] = useState<CardAssignment | null>(null);
  const value = assignment ?? remembered ?? { folderId: '', nodeId: settings.nodeId, agentId: null, modelPreset: null };
  const draft = usePersistentDraft('main-composer', [], '');
  const { value: text, setValue: setText } = draft;
  const [selecting, setSelecting] = useState<'folder' | 'execution' | null>(null);
  // The new-session dialog uses the same upload route with a draft UUID before a session exists.
  const [uploadId, setUploadId] = useState(() => Crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const submitting = React.useRef(false);
  const attachments = useChatAttachments({ api, sessionId: uploadId, nodeId: value.nodeId ?? settings.nodeId ?? undefined,
    disabled: pending });
  const labels = useNewSessionSelection({ visible: true, api, folders, settingsNodeId: settings.nodeId,
    defaultFolderId: value.folderId, defaultNodeId: value.nodeId ?? settings.nodeId,
    defaultAgentId: value.agentId, defaultModelPresetId: value.modelPreset, preserveAgentOnNodeChange: true });
  const disabled = pending || attachments.uploading || !draft.ready;
  const canSend = !!api && !!text.trim() && !!value.folderId && !!value.agentId && !labels.modelPresetSelectionInvalid && !disabled;
  const submit = async () => {
    if (!api || !canSend) return;
    if (submitting.current) return;
    submitting.current = true; setPending(true);
    const scope = captureAuthScope().generation;
    try {
      const { payload, submitNodeId } = buildNewSessionCreatePayload({ text, selectedFolderId: value.folderId,
        agentId: value.agentId, selectedNodeId: value.nodeId, settingsNodeId: settings.nodeId, attachments: attachments.attachments });
      const response = await api.createSession({ ...payload, modelPreset: value.modelPreset ?? labels.effectiveModelPresetId ?? undefined });
      if (captureAuthScope().generation !== scope) return;
      commitNewSessionCreation({ response, text, selectedFolderId: value.folderId, submitNodeId, agentId: value.agentId,
        agents: labels.agents, upsertSession: useSessionStore.getState().upsertSession,
        assignSessionToCatalog: useSessionStore.getState().assignSessionToCatalog,
        setPendingFirstMessage: useChatStore.getState().setPendingFirstMessage,
        onCreated: (id) => { if (onCreated) onCreated(id); else useUIStore.getState().openSessionAtEvent(id); },
        clearAttachments: attachments.clearAttachments, onClose: () => undefined });
      settings.setCardAssignment(settings.serverUrl, value);
      draft.clearIfMatches(text);
      setUploadId(Crypto.randomUUID());
    } catch (cause) { Alert.alert('세션 시작 실패', cause instanceof Error ? cause.message : String(cause)); }
    finally { submitting.current = false; setPending(false); }

  };
  const chip = (label: string, content: string, mode: 'folder' | 'execution') => <CompactTouchTarget
    testID={`card-${mode}-chip`} surfaceTestID={`card-${mode}-chip-visual`}
    accessibilityRole="button" accessibilityLabel={label} disabled={disabled}
    frameStyle={styles.chipFrame} surfaceStyle={[styles.chip, disabled && styles.disabled]}
    onPress={() => setSelecting(mode)}>
    <Text style={styles.chipText} numberOfLines={1}>{content} ▾</Text>
  </CompactTouchTarget>;
  return <>
    <PlannerForegroundCard testID="card-composer" style={styles.frame} cornerRadius={t.radius.lg}>
      <View>
        <ChatComposer input={text} onChangeInput={setText} placeholder="무엇을 시작할까요" inputAccessibilityLabel="세션 첫 메시지"
          sendAccessibilityLabel="세션 시작" onPickAttachment={attachments.pickAttachment} onSend={() => { void submit(); }}
          uploading={attachments.uploading} sending={pending} disabled={pending || !api} sendDisabled={!canSend} voiceControls={null} />
        <AttachmentChips attachments={attachments.attachments} onRemove={attachments.removeAttachment} disabled={disabled}
          styles={{ ...chat, attachmentRow: { ...chat.attachmentRow, paddingHorizontal: 0, paddingTop: 0 },
            attachmentName: { ...chat.attachmentName, ...t.foundation.typography.meta } }}
          textSecondaryColor={t.colors.textSecondary} textMutedColor={t.colors.textMuted} />
        <View testID="card-composer-footer" style={[styles.footer, { paddingHorizontal: chat.inputRow.paddingHorizontal, paddingBottom: t.spacing.sm }]}>
          <View testID="card-composer-chips" style={styles.chips}>
            {chip('폴더 선택', `📁 ${folders.find((folder) => folder.id === value.folderId)?.name ?? '폴더 선택'}`, 'folder')}
            {chip('실행 대상 선택', `${value.agentId ? labels.selectedAgentName : '에이전트'} · ${labels.selectedNodeName || value.nodeId || settings.nodeId} · ${labels.selectedModelPresetName}`, 'execution')}
          </View>

        </View>
      </View>
    </PlannerForegroundCard>
    {selecting === 'folder' ? <FolderSelectionSheet api={api} onClose={() => setSelecting(null)} onSelect={(folderId) => {
      const next = { ...value, folderId }; setAssignment(next); settings.setCardAssignment(settings.serverUrl, next);
    }} /> : null}
    {selecting === 'execution' ? <ExecutionSelectionSheet api={api} value={value} onClose={() => setSelecting(null)} onSave={(next) => {
      setAssignment(next); settings.setCardAssignment(settings.serverUrl, next);
    }} /> : null}
  </>;
}

import { usePersistentDraft } from '../../hooks/usePersistentDraft';
import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import type { ApiClient } from '../../api/client';
import type { CardAssignment } from '../../api/cardTypes';
import { useSettingsStore } from '../../store/settingsStore';
import { useSessionStore } from '../../store/sessionStore';
import { cardOperationId, useCardActions } from '../../hooks/useCardActions';
import { useChatAttachments } from '../../hooks/useChatAttachments';
import { appendCardAttachments, cardAttachmentUrl } from '../../lib/card-attachments';
import { ChatComposer } from '../chat/ChatComposer';
import { AttachmentChips } from '../chat/AttachmentChips';
import { makeStyles as makeChatStyles } from '../chat/ChatBody.styles';
import { useTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { PlannerForegroundCard } from './PlannerForegroundCard';
import { CardAssignmentSheet } from './CardAssignmentSheet';
import { cardStyles } from './Card.styles';
import { TodayCardComposer } from './TodayCardComposer';

export function CardComposer(props: { api: ApiClient | null; folderId?: string; onCreated?(): void; onSessionCreated?(sessionId: string): void; today?: boolean }) {
  return props.today ? <TodayCardComposer api={props.api} onCreated={props.onSessionCreated} /> : <FolderCardComposer {...props} />;
}

function FolderCardComposer({ api, folderId, onCreated }: { api: ApiClient | null; folderId?: string; onCreated?(sessionId?: string): void }) {
  const t = useTokens();
  const styles = useMemo(() => cardStyles(t), [t]);
  const chatStyles = useMemo(() => makeChatStyles(t), [t]);
  const settings = useSettingsStore();
  const folders = useSessionStore((state) => state.catalog.folders);
  const remembered = settings.cardAssignments[settings.serverUrl];
  const [assignment, setAssignment] = useState<CardAssignment | null>(null);
  const value = assignment ?? { folderId: folderId ?? remembered?.folderId ?? '', nodeId: remembered?.nodeId ?? settings.nodeId,
    agentId: folderId && folderId !== remembered?.folderId ? null : remembered?.agentId ?? null, modelPreset: folderId && folderId !== remembered?.folderId ? null : remembered?.modelPreset ?? null };
  const draft = usePersistentDraft('folder-compose', [folderId ?? 'all'], '');
  const { value: text, setValue: setText } = draft;
  const [selecting, setSelecting] = useState(false);
  const { run, pending } = useCardActions(api);
  const [uploadId, setUploadId] = useState(() => Crypto.randomUUID());
  const mapUploadedPath = React.useCallback((path: string, nodeId: string) => cardAttachmentUrl(settings.serverUrl, nodeId, path), [settings.serverUrl]);
  const attachments = useChatAttachments({ api, sessionId: uploadId, nodeId: value.nodeId ?? settings.nodeId ?? undefined,
    disabled: pending, mapUploadedPath });
  const locked = pending || attachments.uploading || !draft.ready;
  const submit = async () => {
    if (!api || !text.trim() || locked) return;
    if (!value.folderId || !value.agentId) { setSelecting(true); return; }
    const request = appendCardAttachments(text, attachments.attachments.map(({ name, path }) => ({ name, url: path })));
    if (await run(() => api.createCard({ folderId: value.folderId, title: request.trim().split('\n')[0], request, queue: true,
      assignee: { kind: 'agent', agentId: value.agentId }, nodeId: value.nodeId, modelPreset: value.modelPreset, idempotencyKey: cardOperationId() }))) {
      settings.setCardAssignment(settings.serverUrl, value);
      draft.clearIfMatches(text); attachments.clearAttachments(); setUploadId(Crypto.randomUUID()); onCreated?.();
    }
  };
  return <>
    <PlannerForegroundCard testID="card-composer">
      <ChatComposer input={text} onChangeInput={setText} placeholder="한 줄로 맡기기" inputAccessibilityLabel="맡길 일"
        sendAccessibilityLabel="카드 맡기기" onPickAttachment={attachments.pickAttachment} onSend={() => { void submit(); }}
        uploading={attachments.uploading} sending={pending} disabled={pending || !api || !draft.ready} sendDisabled={attachments.uploading} voiceControls={null} />
      <AttachmentChips attachments={attachments.attachments} onRemove={attachments.removeAttachment} disabled={locked}
        styles={chatStyles} textSecondaryColor={t.colors.textSecondary} textMutedColor={t.colors.textMuted} />
      <View style={styles.padded}>
        <GlassButton accessibilityLabel="폴더·노드·에이전트·모델 선택" onPress={() => setSelecting(true)} disabled={locked}>
          <Text style={styles.body} numberOfLines={1}>{folders.find((folder) => folder.id === value.folderId)?.name ?? '폴더 선택'} · {value.agentId ?? '담당 선택'} · {value.nodeId || '노드 선택'} · {value.modelPreset ?? '기본 모델'}</Text>
        </GlassButton>
      </View>
    </PlannerForegroundCard>
    {selecting ? <CardAssignmentSheet api={api} value={value} onClose={() => setSelecting(false)} onSave={async (next) => {
      setAssignment(next); settings.setCardAssignment(settings.serverUrl, next);
    }} /> : null}
  </>;
}

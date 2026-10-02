import { usePersistentDraft } from '../../hooks/usePersistentDraft';
import React, { useMemo, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import { cardOperationId, useCardActions } from '../../hooks/useCardActions';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useTokens } from '../../theme';
import { AppModalSurface } from '../AppModalSurface';
import { AppKeyboardAvoidingView } from '../AppKeyboardAvoidingView';
import { GlassButton } from '../GlassSurface';
import { FolderSelectionSheet } from './FolderSelectionSheet';
import { cardStyles } from './Card.styles';

export function CardCreateSheet({ api, onClose, folderId: initialFolderId }: { api: ApiClient | null; onClose(): void; folderId?: string }) {
  const t = useTokens();
  const styles = useMemo(() => cardStyles(t), [t]);
  const remembered = useSettingsStore((state) => state.cardAssignments[state.serverUrl]);
  const folders = useSessionStore((state) => state.catalog.folders);
  const [folderId, setFolderId] = useState(initialFolderId ?? remembered?.folderId ?? '');
  const [title, setTitle] = useState('');
  const draft = usePersistentDraft('card-request', [initialFolderId ?? 'all'], '');
  const { value: request, setValue: setRequest } = draft;
  const [selecting, setSelecting] = useState(false);
  const { run, pending } = useCardActions(api);
  if (selecting) return <FolderSelectionSheet api={api} onClose={() => setSelecting(false)} onSelect={setFolderId} />;
  return <AppModalSurface visible modalId="modal_card_assignment" variant="expanded" presentationStyle="pageSheet" onRequestClose={onClose}>
    <AppKeyboardAvoidingView style={{ flex: 1 }}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>카드 추가</Text>
      <GlassButton accessibilityLabel="카드 폴더 선택" onPress={() => setSelecting(true)} disabled={pending}><Text style={styles.body}>{folders.find((folder) => folder.id === folderId)?.name ?? '폴더 선택'}</Text></GlassButton>
      <TextInput accessibilityLabel="카드 제목" placeholder="제목" value={title} onChangeText={setTitle} style={styles.input} placeholderTextColor={t.colors.textPlaceholder} editable={!pending} />
      <TextInput accessibilityLabel="요청 원문" placeholder="요청 원문" value={request} onChangeText={setRequest} style={styles.input} placeholderTextColor={t.colors.textPlaceholder} multiline editable={!pending && draft.ready} />
      <View style={styles.actions}><GlassButton onPress={onClose} disabled={pending}><Text style={styles.body}>닫기</Text></GlassButton>
        <GlassButton accessibilityLabel="카드 저장" disabled={!api || !draft.ready || pending || !folderId || !title.trim() || !request.trim()} onPress={() => {
          if (api) void run(() => api.createCard({ folderId, title: title.trim(), request, queue: false, idempotencyKey: cardOperationId() })).then((ok) => { if (ok) { draft.clearIfMatches(request); onClose(); } });
        }}><Text style={styles.actionText}>저장</Text></GlassButton></View>
    </ScrollView></AppKeyboardAvoidingView>
  </AppModalSurface>;
}

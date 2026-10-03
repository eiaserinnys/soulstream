import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { GlassButton } from '../components/GlassSurface';
import { FolderWorkspaceReadOverlay } from '../components/planner/FolderWorkspaceReadOverlay';
import { useUIStore } from '../store/uiStore';
import { useTokens } from '../theme';
import { dialogueDetailSamples, dialogueSamples, type DialoguePreviewSample } from './dialogue-inventory';
import { ReviewDialogueSurface } from './ReviewDialogueSurface';

export function ReviewDialoguePreview({ sample }: { sample: DialoguePreviewSample }) {
  const t = useTokens();
  const [opened, setOpened] = useState(true);
  const [result, setResult] = useState('');
  const overlayVisible = useUIStore(state => state.folderOverlayVisible);
  const modal = dialogueSamples.find(item => item.value === sample)?.value;
  const detail = dialogueDetailSamples.some(item => item.value === sample);
  const open = () => {
    setResult('');
    if (sample === 'card-detail') useUIStore.getState().openCardOverlay('public-todo');
    else if (sample === 'folder-detail') useUIStore.getState().openFolderOverlay('public-page');
    else if (sample === 'session-detail') useUIStore.getState().openSessionOverlay('public-idle');
    else setOpened(true);
  };
  useEffect(() => {
    if (detail) open();
    return () => { if (detail) useUIStore.getState().closeFolderOverlay(); };
  }, [sample]);
  const visible = detail ? overlayVisible : opened || overlayVisible;
  return <View testID="dialogue-preview" style={{ flex: 1, backgroundColor: t.colors.background }}>
    {opened && modal ? <ReviewDialogueSurface opened={modal} onClose={() => setOpened(false)} onResult={setResult} preview /> : null}
    {overlayVisible ? <FolderWorkspaceReadOverlay /> : null}
    {!visible ? <View style={{ alignItems: 'flex-start', padding: t.cardLayout.padding, gap: t.spacing.md }}>
      {result ? <Text testID="review-dialogue-result" style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>{result}</Text> : null}
      <GlassButton accessibilityLabel="다시 열기" onPress={open}><Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>다시 열기</Text></GlassButton>
    </View> : null}
  </View>;
}

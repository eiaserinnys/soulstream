import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSessionVisualRoles } from '../sessionVisualRoles';
import {
  DARK_COLORS,
  DESIGN_SPACING,
  PHONE_CHAT_TYPOGRAPHY,
  PHONE_FOUNDATION,
  TABLET_CHAT_TYPOGRAPHY,
  TABLET_FOUNDATION,
  type DesignTokens,
} from '../tokens';

const ROOT = join(__dirname, '../..');
const DIRECT_FILES = [
  'components/SessionCardView.tsx',
  'components/SessionCardById.tsx',
  'components/chat/AttachmentChips.tsx',
  'components/chat/ChatBody.tsx',
  'components/chat/ChatComposer.tsx',
  'components/chat/ChatEventList.tsx',
  'components/chat/ChatInputRequest.tsx',
  'components/chat/ChatInterruptButton.tsx',
  'components/chat/ChatToolApprovalRequest.tsx',
  'components/chat/ClaudeRuntimeSchedulesStrip.tsx',
  'components/chat/ClaudeRuntimeSignalsStrip.tsx',
  'components/chat/ClaudeRuntimeTasksStrip.tsx',
  'components/chat/HistoryFetchError.tsx',
  'components/chat/RealtimeVoiceControls.tsx',
  'components/chat/StatusDot.tsx',
  'components/chat/TypingIndicator.tsx',
  'components/events/AssistantMessage.tsx',
  'components/events/EventContextMenu.tsx',
  'components/events/EventRenderer.tsx',
  'components/events/MessageTextSelectionView.tsx',
  'components/events/SystemEvent.tsx',
  'components/events/ThinkingEvent.tsx',
  'components/events/ToolEvent.tsx',
  'components/events/UserMessage.tsx',
  'screens/ChatScreen.tsx',
  'screens/SessionFeedScreen.tsx',
  'components/useSessionReviewAcknowledge.ts',
  'hooks/useChatAttachments.ts',
] as const;

test('N4 폐쇄 산술은 28 files / 34 units / 미할당 0이다', () => {
  expect(new Set(DIRECT_FILES).size).toBe(28);
  for (const file of DIRECT_FILES) {
    expect(readFileSync(join(ROOT, file), 'utf8').length).toBeGreaterThan(0);
  }
  const unitCounts = [
    1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 3, 3, 1, 2, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  ];
  expect(unitCounts.reduce((sum, count) => sum + count, 0)).toBe(34);
});

test.each([
  ['phone', 44, 17],
  ['tabletPortrait', 48, 18],
] as const)('%s session/chat role vocabulary', (device, hitTarget, chatBody) => {
  const tokens = {
    foundation: device === 'phone' ? PHONE_FOUNDATION : TABLET_FOUNDATION,
    chatFontSize: device === 'phone' ? PHONE_CHAT_TYPOGRAPHY : TABLET_CHAT_TYPOGRAPHY,
    uiSpacing: DESIGN_SPACING,
    colors: DARK_COLORS,
  } as DesignTokens;
  const roles = createSessionVisualRoles(tokens);
  expect(roles.feed).toMatchObject({
    pageInset: 20,
    cardPadding: 16,
    avatar: 44,
    statusColumn: 76,
    chip: {
      minHeight: 24,
      paddingHorizontal: 8,
      paddingVertical: 0,
      radius: 8,
    },
  });
  expect(roles.typography.title).toMatchObject({ fontSize: 16, lineHeight: 22 });
  expect(roles.typography.meta).toMatchObject({ fontSize: 13, lineHeight: 18 });
  expect(roles.typography.time).toMatchObject({ fontSize: 12, lineHeight: 16 });
  expect(roles.chat).toMatchObject({
    body: chatBody,
    messageGap: 12,
    bubblePaddingHorizontal: 16,
    bubblePaddingVertical: 14,
    bubbleMaxWidth: '86%',
    attachment: {
      assistantMaxWidth: 360,
      userMaxWidth: 320,
      phoneAssistantMaxWidth: '100%',
      phoneUserMaxWidth: '88%',
      radius: 10,
      filenameGap: 6,
      gridGap: 12,
      metadata: { fontSize: 13, lineHeight: 18 },
    },
    tool: {
      visualMinHeight: 40,
      fontSize: 13,
      lineHeight: 18,
      stateIconSize: 17,
      chevronSize: 14,
      paddingHorizontal: 12,
      paddingVertical: 6,
      gap: 6,
      rowGap: 6,
      bodyPadding: 12,
      codeFontSize: 13,
      codeLineHeight: 19,
    },
    composer: {
      minHeight: 56,
      contentMinHeight: 48,
      edgePaddingHorizontal: 6,
      edgePaddingVertical: 4,
      controlGap: 6,
      inputPaddingHorizontal: 8,
      inputPaddingVertical: 10,
      controlVisualSize: 40,
      hitTarget,
    },
  });
});

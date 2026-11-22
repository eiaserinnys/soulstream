import { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { MessageAttachments } from '../../../src/components/MessageAttachments';
import { CardQuestionBody } from '../../../src/components/planner/CardQuestionBlock';
import type { CardQuestionView } from '../../../src/components/planner/card-question-viewmodel';
import { useAuthStore } from '../../../src/store/authStore';
import { useSettingsStore } from '../../../src/store/settingsStore';
import { useTokens } from '../../../src/theme';
import { attachmentPreviewHarnessItems } from './fixtures';

// Same store bootstrapping the component-review shell uses for ?section=attachments:
// no login, public node, fixtures served from the same origin.
const search = typeof window === 'undefined' ? '' : window.location.search;
const params = new URLSearchParams(search);
useSettingsStore.setState({
  serverUrl: typeof window === 'undefined' ? '' : window.location.origin,
  nodeId: 'public-node',
  appearance: params.get('theme') === 'dark' ? 'dark' : 'light',
});
useAuthStore.setState({ jwt: null, authRejected: false });

// Descriptor URL without an extension: only the descriptor mime tells this apart from a file.
const questionView: CardQuestionView = {
  id: 'harness-question',
  title: null,
  background: '',
  kind: 'request',
  options: [],
  attachments: [{
    type: 'image',
    label: '흐름 도면',
    url: '/fixtures/drawing',
    attachment_id: 'harness-drawing',
    read_context: { type: 'card', id: 'harness-card' },
    previewUrl: '/fixtures/drawing',
    originalUrl: '/fixtures/drawing',
    descriptor: {
      attachment_id: 'harness-drawing',
      name: 'drawing',
      mime_type: 'image/svg+xml',
      byte_size: 640,
      checksum_sha256: null,
      width: 320,
      height: 200,
      preview_kind: 'image',
      preview_mime_type: 'image/svg+xml',
    },
  }],
  thread: [],
  open: true,
  selectedOption: null,
  answer: null,
  revisedAt: null,
  awaitingAgent: false,
};

export function Harness() {
  return params.get('section') === 'question' ? <QuestionHarness /> : <AttachmentListHarness />;
}

function AttachmentListHarness() {
  const t = useTokens();
  const items = useMemo(() => attachmentPreviewHarnessItems(), []);
  return <View testID="attachment-preview-harness" style={{ flex: 1, backgroundColor: t.colors.background }}>
    <ScrollView
      testID="attachment-preview-harness-scroll"
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: t.foundation.pageInset, gap: t.uiSpacing.lg }}
      showsVerticalScrollIndicator={false}
    >
      <MessageAttachments items={items} role="assistant" />
    </ScrollView>
  </View>;
}

function QuestionHarness() {
  const t = useTokens();
  return <View testID="attachment-preview-question" style={{ flex: 1, backgroundColor: t.colors.background }}>
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: t.foundation.pageInset, gap: t.uiSpacing.lg }}
      showsVerticalScrollIndicator={false}
    >
      <CardQuestionBody view={questionView} cardId="harness-card" portraitUri={null} onChoose={() => {}} />
    </ScrollView>
  </View>;
}

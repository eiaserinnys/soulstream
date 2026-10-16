import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { AttachmentView } from '../../lib/attachment-view';
import {
  AttachmentReadContextProvider,
  ContentLinkProvider,
  useAttachmentReadContext,
  useContentLinkImageHost,
} from '../ContentLinkProvider';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

const view: AttachmentView = {
  key: 'asset-1',
  name: 'notes.bin',
  mimeType: 'application/octet-stream',
  byteSize: null,
  previewKind: 'info',
  readContext: { type: 'card', id: 'card-1' },
  source: {
    kind: 'ready',
    attachmentId: 'asset-1',
    previewUrl: '/api/attachments/asset-1/content?context_type=card&context_id=card-1',
    originalUrl: '/api/attachments/asset-1/content?context_type=card&context_id=card-1&download=true',
  },
};

function HostProbe() {
  const host = useContentLinkImageHost();
  const context = useAttachmentReadContext();
  return <>
    <Text testID="attachment-read-context">{JSON.stringify(context)}</Text>
    <Text testID="open-attachment" onPress={() => host?.openAttachment(view)}>open</Text>
    <Text testID="open-image" onPress={() => host?.openImage({ uri: 'https://soulstream.test/image.png' })}>image</Text>
  </>;
}

test('nearest read context is available and the host opens attachment previews while keeping image opening', () => {
  const context = { type: 'card' as const, id: 'card-1' };
  const screen = render(<ContentLinkProvider>
    <AttachmentReadContextProvider context={context}><HostProbe /></AttachmentReadContextProvider>
  </ContentLinkProvider>);

  expect(screen.getByTestId('attachment-read-context').props.children).toBe(JSON.stringify(context));
  fireEvent.press(screen.getByTestId('open-attachment'));
  expect(screen.getByTestId('attachment-preview-modal')).toBeTruthy();
  expect(screen.getByText('notes.bin')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('첨부 미리보기 닫기'));
  expect(screen.queryByTestId('attachment-preview-modal')).toBeNull();

  fireEvent.press(screen.getByTestId('open-image'));
  expect(screen.getByTestId('image-viewer-pages')).toBeTruthy();
});

test('read context provider has no context outside its explicit subtree', () => {
  function Probe() {
    return <Text testID="empty-read-context">{String(useAttachmentReadContext())}</Text>;
  }
  const screen = render(<Probe />);
  expect(screen.getByTestId('empty-read-context').props.children).toBe('undefined');
});

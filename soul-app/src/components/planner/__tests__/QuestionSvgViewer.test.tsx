import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { Image } from 'react-native';

jest.mock('react-native-enriched-markdown', () => ({
  EnrichedMarkdownText: (props: { markdown?: string }) =>
    require('react').createElement(require('react-native').Text, { testID: 'markdown' }, props.markdown),
}));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

import { CardQuestionBody } from '../CardQuestionBlock';
import { AttachmentSvg } from '../../AttachmentSvg';
import { useSettingsStore } from '../../../store/settingsStore';
import { useAuthStore } from '../../../store/authStore';

test('세라피엘 재현: 질문 SVG 첨부 타일과 눌러 연 보기 창의 그리는 쪽', () => {
  useSettingsStore.setState({ serverUrl: 'https://app.test' });
  useAuthStore.setState({ jwt: 'fixture-token' });
  const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => new Promise(() => {}));
  const view = {
    id: 'q', title: null, background: '배경', kind: 'choice' as const, options: [],
    attachments: [{
      type: 'image' as const, label: '흐름 도면', url: '/api/attachments/att-1/content',
      attachment_id: 'att-1', previewUrl: '/api/attachments/att-1/preview', originalUrl: '/api/attachments/att-1/content',
      read_context: { type: 'card' as const, id: 'card' },
      descriptor: {
        attachment_id: 'att-1', name: 'flow.svg', mime_type: 'image/svg+xml', byte_size: 900, checksum_sha256: null,
        width: null, height: null, preview_kind: 'image', preview_mime_type: 'image/svg+xml',
      },
    }],
    thread: [], open: true, selectedOption: null, answer: null, revisedAt: null, awaitingAgent: true,
  };
  const screen = render(<CardQuestionBody view={view as never} cardId="card" portraitUri={null} onChoose={() => {}} />);
  expect(screen.UNSAFE_queryAllByType(AttachmentSvg)).toHaveLength(1);
  fireEvent.press(screen.getAllByLabelText('흐름 도면')[0]);
  const pages = screen.getByTestId('image-viewer-pages');
  expect(within(pages).UNSAFE_queryAllByType(AttachmentSvg)).toHaveLength(1);
  expect(within(pages).UNSAFE_queryAllByType(Image)).toHaveLength(0);
  screen.unmount();
  fetchSpy.mockRestore();
  act(() => { useAuthStore.setState({ jwt: null }); });
});

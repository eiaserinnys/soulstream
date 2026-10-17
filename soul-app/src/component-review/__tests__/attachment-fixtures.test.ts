import { chatUiAttachmentReviewHistory, chatUiReviewHistory, chatUiReviewSseUrl, chatUiReviewSessionId } from '../chat-ui-flow-fixtures';

const sampleSearch = '?section=chatUiRenderer&sample=attachments';
const { loadedImageWithin, assertAssistantAlignment } = require('../../../scripts/attachment-capture-checks.cjs');
const { contrastRatio, assertAttachmentColors } = require('../../../scripts/attachment-capture-colors.cjs');

it('rejects muted bubble captions, translucent file surfaces, and insufficient file contrast', () => {
  expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21);
  const colors = { body: { color: '#000000', background: '#ffffff' },
    captions: [{ color: '#000000', opacity: 1 }], statuses: [],
    fileText: [{ text: '자료.txt', color: '#000000', background: 'rgb(255, 255, 255)', opacity: 1 }] };
  expect(() => assertAttachmentColors(colors)).not.toThrow();
  expect(() => assertAttachmentColors({ ...colors, captions: [{ color: '#53575d', opacity: 1 }] })).toThrow(/matches message body/);
  expect(() => assertAttachmentColors({ ...colors, fileText: [{ ...colors.fileText[0], background: 'rgba(255, 255, 255, 0.5)' }] })).toThrow(/surface is opaque/);
  expect(() => assertAttachmentColors({ ...colors, fileText: [{ ...colors.fileText[0], color: '#ffffff' }] })).toThrow(/contrast 1/);
});

it('rejects an output gallery at the screen edge instead of the assistant text edge', () => {
  expect(() => assertAssistantAlignment('phone', 0, 68)).toThrow(/-68px/);
  expect(() => assertAssistantAlignment('phone', 68, 68)).not.toThrow();
  expect(() => assertAssistantAlignment('manuscript', 12, 12)).not.toThrow();
});

it('waits for the nested RN web image and rejects missing or unloaded images', () => {
  const image = { tagName: 'IMG', complete: true, naturalWidth: 256, currentSrc: '/preview' };
  const host = { tagName: 'DIV', querySelector: () => image };
  expect(loadedImageWithin(host)).toEqual({ hostTag: 'DIV', imageTag: 'IMG', naturalWidth: 256, url: '/preview' });
  expect(loadedImageWithin(image)).toMatchObject({ hostTag: 'IMG', naturalWidth: 256 });
  expect(loadedImageWithin({ ...host, querySelector: () => null })).toBe(false);
  image.naturalWidth = 0;
  expect(loadedImageWithin(host)).toBe(false);
  image.naturalWidth = 256;
  image.complete = false;
  expect(loadedImageWithin(host)).toBe(false);
});

it('registers the chat attachment sample with the P6B history event shape', () => {
  const history = chatUiReviewHistory(sampleSearch);
  expect(history).toEqual(chatUiAttachmentReviewHistory());
  expect(history.map(({ id, event_type }) => [id, event_type])).toEqual([
    [105, 'user_message'], [104, 'complete'], [103, 'assistant_message'],
    [102, 'assistant_message'], [101, 'user_message'],
  ]);

  const bodylessUserMessage = history.find(event => event.id === 105)!;
  expect(bodylessUserMessage.payload).toEqual({ attachment_ids: ['review-chat-empty-text'] });
  expect(history.find(event => event.id === 101)?.payload).toEqual({
    text: '검토 자료를 함께 보냅니다.',
    attachment_ids: ['review-chat-image-one', 'review-chat-image-two', 'review-chat-empty-text'],
  });

  const output = history.find(event => event.id === 103)!;
  expect(output.payload).toEqual({
    content: '',
    attachment_ids: ['review-agent-output-image'],
    attachment_output: true,
    output_command_id: 'execute:review-chat-attachments',
  });
  expect(history.find(event => event.id === 104)?.payload).toEqual({
    attachment_ids: ['review-agent-output-image'],
    output_command_id: 'execute:review-chat-attachments',
  });
});

it('uses the same attachment events for default and PAS history and live frames', () => {
  const defaultHistory = chatUiReviewHistory(sampleSearch);
  const pasHistory = chatUiReviewHistory(`${sampleSearch}&presentation=manuscript`);
  expect(pasHistory).toEqual(defaultHistory);

  const dataUrl = chatUiReviewSseUrl(chatUiReviewSessionId, sampleSearch, '102');
  const stream = decodeURIComponent(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const liveEvents = [...stream.matchAll(/event: ([^\n]+)\ndata: ([^\n]+)\n\n/g)]
    .map(([, type, raw]) => ({ type, data: JSON.parse(raw) as Record<string, unknown> }));
  const output = liveEvents.find(frame => frame.type === 'assistant_message' && frame.data.attachment_output === true);
  expect(output?.data).toMatchObject({
    session_id: chatUiReviewSessionId,
    _event_id: 103,
    attachment_ids: ['review-agent-output-image'],
    attachment_output: true,
    output_command_id: 'execute:review-chat-attachments',
  });
  expect(liveEvents.find(frame => frame.type === 'complete')?.data).toMatchObject({
    attachment_ids: ['review-agent-output-image'],
    output_command_id: 'execute:review-chat-attachments',
  });
});

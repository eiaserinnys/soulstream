import { render } from '@testing-library/react-native';
import { UserMessage } from '../UserMessage';
import { extractMessageCaller, pickUserAvatarUri } from '../userAvatarHelpers';

const cases = [
  ['access_link', '연동', '접속 링크'],
  ['webhook', '알림', '웹훅'],
  [undefined, '이름', '접속 링크'],
  [undefined, '', '접속 링크'],
  [undefined, '가'.repeat(80), '접속 링크'],
] as const;

test.each(cases)('external caller %s is identified and rendered', (transport, label, title) => {
  const event = { id: '1', type: 'user_message', data: { text: '본문', caller_info: { source: 'external', transport, display_name: label, issued_by: 'owner@example.com' } } } as any;
  const caller = extractMessageCaller(event);
  expect(caller?.source).toBe('external');
  expect(caller?.transport).toBe(transport);
  expect(pickUserAvatarUri({ ...caller, source: 'external', avatar_url: 'https://director' }, { picture: 'https://director' } as any, '/director', 'https://server').uri).toBeNull();
  for (const presentation of ['default', 'manuscript'] as const) {
    const screen = render(<UserMessage event={event} presentation={presentation} />);
    expect(screen.getByText('외부 연동')).toBeTruthy();
    if (label) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByLabelText(`외부 연동 ${title}`)).toBeTruthy();
    expect(JSON.stringify(screen.toJSON())).not.toContain('owner@example.com');
    screen.unmount();
  }
});

test('intervention shows the external sender', () => {
  const screen = render(<UserMessage variant="intervention" event={{ id: '2', type: 'intervention_sent', data: { text: '본문', caller_info: { source: 'external', transport: 'webhook', display_name: '알림' } } } as any} />);
  expect(screen.getByText('외부 연동')).toBeTruthy();
  expect(screen.getByLabelText('외부 연동 웹훅')).toBeTruthy();
});

test.each(['browser', 'agent'])('%s does not get an external label', source => {
  const screen = render(<UserMessage event={{ id: '1', type: 'user_message', data: { text: '본문', caller_info: { source } } } as any} />);
  expect(screen.queryByText('외부 연동')).toBeNull();
});

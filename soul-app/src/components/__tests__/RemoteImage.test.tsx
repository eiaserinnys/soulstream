import { Text } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import { RemoteImage } from '../RemoteImage';

const SERVER = 'https://soul.test';

test('버전 주소는 memory-disk, v 없는 주소와 바깥 주소는 memory 캐시로 그린다', () => {
  const screen = render(<>
    <RemoteImage testID="versioned" source={{ uri: `${SERVER}/api/agent-portraits/a?v=1` }} />
    <RemoteImage testID="attachment" source={{ uri: `${SERVER}/api/attachments/x/content` }} />
    <RemoteImage testID="plain" source={{ uri: `${SERVER}/api/agent-portraits/a` }} />
    <RemoteImage testID="google" source={{ uri: 'https://lh3.googleusercontent.com/a.png' }} />
  </>);
  expect(screen.getByTestId('versioned').props.cachePolicy).toBe('memory-disk');
  expect(screen.getByTestId('attachment').props.cachePolicy).toBe('memory-disk');
  expect(screen.getByTestId('plain').props.cachePolicy).toBe('memory');
  expect(screen.getByTestId('google').props.cachePolicy).toBe('memory');
});

test('source의 uri와 headers, contentFit을 그대로 넘기고 contentFit 기본은 cover다', () => {
  const headers = { Authorization: 'Bearer tok' };
  const screen = render(<RemoteImage testID="img" source={{ uri: `${SERVER}/api/agent-portraits/a?v=1`, headers }} />);
  expect(screen.getByTestId('img').props.source).toEqual({ uri: `${SERVER}/api/agent-portraits/a?v=1`, headers });
  expect(screen.getByTestId('img').props.contentFit).toBe('cover');
});

test('로컬 asset은 캐시 정책 없이 그대로 그린다', () => {
  const screen = render(<RemoteImage testID="local" source={7} />);
  expect(screen.getByTestId('local').props.source).toBe(7);
  expect(screen.getByTestId('local').props.cachePolicy).toBeUndefined();
});

test('실패하면 대체 표시를 보이고 onError를 부르며, 주소가 바뀌면 풀려 그림을 다시 그린다', () => {
  const onError = jest.fn();
  const fallback = <Text>대체</Text>;
  const screen = render(<RemoteImage testID="img" source={{ uri: `${SERVER}/api/agent-portraits/a?v=1` }} fallback={fallback} onError={onError} />);
  fireEvent(screen.getByTestId('img'), 'error');
  expect(onError).toHaveBeenCalledTimes(1);
  expect(screen.getByText('대체')).toBeTruthy();
  expect(screen.queryByTestId('img')).toBeNull();

  screen.rerender(<RemoteImage testID="img" source={{ uri: `${SERVER}/api/agent-portraits/a?v=2` }} fallback={fallback} onError={onError} />);
  expect(screen.queryByText('대체')).toBeNull();
  expect(screen.getByTestId('img').props.source).toEqual({ uri: `${SERVER}/api/agent-portraits/a?v=2` });
});

test('같은 주소라도 인증 머리가 바뀌면 실패 상태가 풀린다', () => {
  const screen = render(<RemoteImage testID="img" source={{ uri: `${SERVER}/p`, headers: { Authorization: 'Bearer old' } }} fallback={<Text>대체</Text>} />);
  fireEvent(screen.getByTestId('img'), 'error');
  expect(screen.getByText('대체')).toBeTruthy();
  screen.rerender(<RemoteImage testID="img" source={{ uri: `${SERVER}/p`, headers: { Authorization: 'Bearer new' } }} fallback={<Text>대체</Text>} />);
  expect(screen.queryByText('대체')).toBeNull();
});

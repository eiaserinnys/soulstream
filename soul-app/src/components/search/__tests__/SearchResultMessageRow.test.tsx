import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { SearchResultMessageRow } from '../SearchResultMessageRow';

test('본문 결과는 세션 제목, 발화 종류, 일치 구간을 함께 읽어 준다', () => {
  const onPress = jest.fn();
  const screen = render(
    <SearchResultMessageRow
      sessionTitle="검색 구현"
      eventType="assistant_message"
      matchSource="message"
      preview="앞 문장 Alpha 뒤 문장"
      query="alpha"
      selected
      onPress={onPress}
    />,
  );

  expect(screen.getByText('검색 구현')).toBeTruthy();
  expect(screen.getByText('응답')).toBeTruthy();
  expect(screen.getByText('Alpha').props.style).toEqual(
    expect.arrayContaining([expect.objectContaining({ fontWeight: '700' })]),
  );
  expect(
    screen.getByLabelText('대화 내용 결과, 검색 구현, 응답, 앞 문장 Alpha 뒤 문장'),
  ).toBeTruthy();
  fireEvent.press(screen.getByTestId('search-message-result'));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test.each([
  ['turn_summary', '턴 요약'],
  ['highlight', '하이라이트'],
  ['story', '줄거리'],
] as const)('%s 출처는 보조 뱃지로 표시한다', (matchSource, label) => {
  const screen = render(
    <SearchResultMessageRow
      sessionTitle="검색 구현"
      eventType="assistant_message"
      matchSource={matchSource}
      preview="일치 구간"
      query="일치"
      onPress={jest.fn()}
    />,
  );

  expect(screen.getByText(label)).toBeTruthy();
});

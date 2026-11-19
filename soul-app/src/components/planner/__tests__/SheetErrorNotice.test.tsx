import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { SheetErrorNotice, sheetErrorDetail } from '../SheetErrorNotice';

test('원문은 처음에 접혀 있고 펼치면 그대로 보인다', () => {
  const raw = 'HTTP 403 Authorization: Bearer synthetic-auth Cookie: synthetic-cookie password=synthetic-pass token=synthetic-token api_key=synthetic-key https://synthetic-user:synthetic-password@example.test/?secret=synthetic-query';
  const detail = sheetErrorDetail(new Error(raw));
  const screen = render(<SheetErrorNotice summary="저장하지 못했습니다." detail={detail} />);
  expect(JSON.stringify(screen.toJSON())).not.toContain('synthetic-');
  fireEvent.press(screen.getByLabelText('기술 상세'));
  expect(screen.getByText(raw)).toBeTruthy();
  fireEvent.press(screen.getByLabelText('기술 상세'));
  expect(screen.getByLabelText('기술 상세').props.accessibilityState.expanded).toBe(false);
});

test.each(['', '   ', '저장하지 못했습니다.'])('상세가 비었거나 요약과 같으면 단추가 없다: %j', detail => {
  const screen = render(<SheetErrorNotice summary="저장하지 못했습니다." detail={detail} />);
  expect(screen.queryByLabelText('기술 상세')).toBeNull();
});

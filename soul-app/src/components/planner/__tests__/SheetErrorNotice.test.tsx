import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { SheetErrorNotice, sheetErrorDetail } from '../SheetErrorNotice';

test('닫힌 화면과 펼친 상세 모두 합성 비밀을 렌더하지 않고 진단 필드만 표시한다', () => {
  const raw = 'HTTP 403 Authorization: Bearer synthetic-auth Cookie: synthetic-cookie password=synthetic-pass token=synthetic-token api_key=synthetic-key https://synthetic-user:synthetic-password@example.test/?secret=synthetic-query';
  const detail = sheetErrorDetail(new Error(raw));
  const screen = render(<SheetErrorNotice summary="저장하지 못했습니다." detail={detail} />);
  expect(JSON.stringify(screen.toJSON())).not.toContain('synthetic-');
  fireEvent.press(screen.getByLabelText('기술 상세'));
  expect(screen.getByText(/HTTP 403/)).toBeTruthy();
  expect(JSON.stringify(screen.toJSON())).not.toContain('synthetic-');
  fireEvent.press(screen.getByLabelText('기술 상세'));
  expect(screen.getByLabelText('기술 상세').props.accessibilityState.expanded).toBe(false);
});

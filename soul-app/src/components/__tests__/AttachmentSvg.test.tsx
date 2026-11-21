import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { AttachmentSvg, fitSvgBox, svgAspectRatio } from '../AttachmentSvg';

jest.mock('react-native-svg', () => ({
  SvgXml: (props: any) => require('react').createElement(require('react-native').View, { testID: 'svg-xml', ...props }),
}));

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#123"/></svg>';

function respond(body: string | null, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body ?? '',
  } as unknown as Response;
}

test('SVG viewBox로 비율을 계산한다', () => {
  expect(svgAspectRatio(SVG)).toBe(2);
  expect(svgAspectRatio('<svg width="30" height="60"></svg>')).toBe(0.5);
  expect(svgAspectRatio('<svg viewBox="0 0 0 10"></svg>')).toBeNull();
  expect(svgAspectRatio('<svg></svg>')).toBeNull();
});

test('fitSvgBox는 영역 안에서 비율을 유지한 가장 큰 상자를 준다', () => {
  expect(fitSvgBox({ width: 200, height: 200 }, 2)).toEqual({ width: 200, height: 100 });
  expect(fitSvgBox({ width: 200, height: 200 }, 0.5)).toEqual({ width: 100, height: 200 });
  expect(fitSvgBox({ width: 200, height: 200 }, null)).toEqual({ width: 200, height: 200 });
});

test('인증 헤더로 SVG를 읽어 밝은 배경 위에 그린다', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(respond(SVG));
  try {
    const screen = render(<AttachmentSvg
      source={{ uri: 'https://soul.test/files?path=logo.svg', headers: { Authorization: 'Bearer jwt' } }}
      label="로고"
      radius={8}
      testID="svg-attachment"
    />);
    fireEvent(screen.getByTestId('svg-attachment'), 'layout', {
      nativeEvent: { layout: { width: 200, height: 200 } },
    });
    await waitFor(() => expect(screen.getByTestId('svg-xml')).toBeTruthy());

    expect(fetchMock).toHaveBeenCalledWith('https://soul.test/files?path=logo.svg', {
      headers: { Authorization: 'Bearer jwt' },
      signal: expect.any(AbortSignal),
    });
    const drawing = screen.getByTestId('svg-xml');
    expect(drawing.props.xml).toBe(SVG);
    expect(drawing.props.width).toBe(200);
    expect(drawing.props.height).toBe(100);
    expect(screen.getByTestId('svg-attachment').props.accessibilityLabel).toBe('로고');
  } finally {
    fetchMock.mockRestore();
  }
});

test('SVG를 읽지 못하면 타일 크기를 유지한 채 짧은 실패 문구를 보인다', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(respond(null, 404));
  try {
    const screen = render(<AttachmentSvg source={{ uri: 'https://soul.test/missing.svg' }} label="로고" />);
    await waitFor(() => expect(screen.getByText('불러오지 못함')).toBeTruthy());
    expect(screen.queryByTestId('svg-xml')).toBeNull();
  } finally {
    fetchMock.mockRestore();
  }
});

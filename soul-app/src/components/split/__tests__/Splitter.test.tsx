import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { Splitter } from '../Splitter';

test('스플리터는 전고선 없이 12pt gutter 안에 옅은 중앙 grabber와 44pt 이상 터치 폭을 제공한다', () => {
  const screen = render(
    <Splitter initialWidth={320} onWidthChange={jest.fn()} />,
  );
  const touchZone = screen.getByTestId('splitter-touch-zone');
  const grabber = screen.getByTestId('splitter-grabber');
  const style = StyleSheet.flatten(touchZone.props.style);
  const grabberStyle = StyleSheet.flatten(grabber.props.style);

  expect(style.width).toBeGreaterThanOrEqual(44);
  expect(style.width + style.marginHorizontal * 2).toBe(12);
  expect(style.zIndex).toBeGreaterThan(0);
  expect(touchZone.children).toHaveLength(1);
  expect(grabberStyle.width).toBeGreaterThan(1);
  expect(grabberStyle.height).toBeGreaterThan(grabberStyle.width);
  expect(grabberStyle.borderRadius).toBeGreaterThan(0);
  expect(grabberStyle.opacity).toBeLessThan(1);
});

test('grabber는 드래그 중 theme active 색으로 하이라이트되고 종료하면 복귀한다', () => {
  const screen = render(
    <Splitter initialWidth={320} onWidthChange={jest.fn()} />,
  );
  const touchZone = screen.getByTestId('splitter-touch-zone');
  const grabber = screen.getByTestId('splitter-grabber');
  const idleColor = StyleSheet.flatten(grabber.props.style).backgroundColor;

  fireEvent(touchZone, 'responderGrant', responderEvent());
  const activeColor = StyleSheet.flatten(
    screen.getByTestId('splitter-grabber').props.style,
  ).backgroundColor;

  expect(activeColor).not.toBe(idleColor);
  expect(StyleSheet.flatten(
    screen.getByTestId('splitter-grabber').props.style,
  ).opacity).toBe(1);

  fireEvent(touchZone, 'responderRelease', responderEvent());
  expect(
    StyleSheet.flatten(screen.getByTestId('splitter-grabber').props.style)
      .backgroundColor,
  ).toBe(idleColor);
});

function responderEvent() {
  return {
    touchHistory: {
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: 1,
      touchBank: [{
        touchActive: true,
        currentPageX: 0,
        currentPageY: 0,
        currentTimeStamp: 1,
        previousPageX: 0,
        previousPageY: 0,
        previousTimeStamp: 0,
      }],
    },
  };
}

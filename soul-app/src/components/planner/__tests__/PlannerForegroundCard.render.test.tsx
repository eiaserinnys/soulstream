import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { PlannerForegroundCard } from '../PlannerForegroundCard';

jest.mock('../../AppGlassCard', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { AppGlassCard: ({ testID, style }: { testID: string; style: unknown }) =>
    React.createElement(View, { testID, style }) };
});

test('긴 글의 유리 배경은 전경 텍스트보다 먼저 놓인다', () => {
  const screen = render(
    <PlannerForegroundCard glassTestID="glass" foregroundTestID="foreground">
      <Text>읽을 수 있는 글</Text>
    </PlannerForegroundCard>,
  );
  const tree = screen.toJSON()!;
  expect(Array.isArray(tree)).toBe(false);
  if (Array.isArray(tree)) return;
  const children = tree.children as typeof tree[];
  expect(children.map((child) => child.props.testID)).toEqual(['glass', 'foreground']);
  const glass = StyleSheet.flatten(children[0].props.style);
  const foreground = StyleSheet.flatten(children[1].props.style);
  expect(glass.position).toBe('absolute');
  expect(foreground.zIndex).toBeGreaterThan(glass.zIndex);
});

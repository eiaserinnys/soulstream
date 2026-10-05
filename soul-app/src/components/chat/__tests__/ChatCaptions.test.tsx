import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { fireEvent, render, within } from '@testing-library/react-native';
import { FOUNDATION_RADIUS, TABLET_CHAT_TYPOGRAPHY, TABLET_SPACING, DESIGN_SPACING } from '../../../theme';
import { LIGHT_COLORS } from '../../../theme/colors';
import { CollapsibleCaption, CollapsibleCaptionLine } from '../CollapsibleCaption';
import { LabeledDivider } from '../LabeledDivider';

describe('CollapsibleCaption', () => {
  test('기본 접힘, 제목 접근성, 펼침 상태와 처음 상태의 mount 한정 적용', () => {
    const screen = render(
      <CollapsibleCaption title="Jev 후보 3">
        <Text>요약 내용</Text>
      </CollapsibleCaption>,
    );
    const button = screen.getByRole('button', { name: 'Jev 후보 3' });
    expect(button.props.accessibilityState).toEqual({ expanded: false });
    expect(screen.queryByText('요약 내용')).toBeNull();

    fireEvent.press(button);
    const expandedButton = screen.getByRole('button', { name: 'Jev 후보 3' });
    expect(expandedButton.props.accessibilityState)
      .toEqual({ expanded: true });
    expect(screen.getByText('요약 내용')).toBeTruthy();
    expect(within(expandedButton).getByText('요약 내용')).toBeTruthy();

    screen.rerender(
      <CollapsibleCaption title="Jev 후보 3" initiallyCollapsed>
        <Text>요약 내용</Text>
      </CollapsibleCaption>,
    );
    expect(screen.getByRole('button', { name: 'Jev 후보 3' }).props.accessibilityState)
      .toEqual({ expanded: true });
    fireEvent.press(screen.getByText('요약 내용'));
    expect(screen.getByRole('button', { name: 'Jev 후보 3' }).props.accessibilityState)
      .toEqual({ expanded: false });
  });

  test('처음부터 펼침과 제목 말줄임을 지원한다', () => {
    const title = '아주 긴 제목은 화면 너비를 넘어도 한 줄로 끝에서 잘립니다';
    const screen = render(
      <CollapsibleCaption title={title} initiallyCollapsed={false}>
        <CollapsibleCaptionLine>내용</CollapsibleCaptionLine>
      </CollapsibleCaption>,
    );
    const titleText = screen.getByText(title);
    expect(titleText.props.numberOfLines).toBe(1);
    expect(titleText.props.ellipsizeMode).toBe('tail');
    const contentLine = screen.getByText('내용');
    expect(contentLine.props.numberOfLines).toBe(1);
    expect(contentLine.props.ellipsizeMode).toBe('tail');
    expect(StyleSheet.flatten(contentLine.props.style)).toMatchObject({
      color: LIGHT_COLORS.textPlaceholder,
      fontSize: TABLET_CHAT_TYPOGRAPHY.meta,
      lineHeight: TABLET_CHAT_TYPOGRAPHY.meta * 1.3,
    });
    expect(screen.getByRole('button', { name: title }).props.accessibilityState)
      .toEqual({ expanded: true });
    const button = screen.getByRole('button', { name: title });
    expect(button.props.accessibilityState).toEqual({ expanded: true });
    const titleRow = screen.UNSAFE_getAllByType(View).find((view) =>
      StyleSheet.flatten(view.props.style).borderRadius === FOUNDATION_RADIUS.chip);
    expect(titleRow).toBeTruthy();
    expect(StyleSheet.flatten(titleRow?.props.style)).toMatchObject({
      alignSelf: 'flex-start',
      maxWidth: '100%',
      paddingHorizontal: DESIGN_SPACING.sm,
      marginLeft: -DESIGN_SPACING.sm,
    });
    expect(StyleSheet.flatten(titleText.props.style)).toMatchObject({
      color: LIGHT_COLORS.textPlaceholder,
    });
    fireEvent(button, 'pressIn');
    const pressedTitleRow = screen.UNSAFE_getAllByType(View).find((view) =>
      StyleSheet.flatten(view.props.style).borderRadius === FOUNDATION_RADIUS.chip);
    expect(StyleSheet.flatten(pressedTitleRow?.props.style)).toMatchObject({
      borderRadius: FOUNDATION_RADIUS.chip,
      backgroundColor: LIGHT_COLORS.surfaceMuted,
    });
    expect(StyleSheet.flatten(titleText.props.style)).toMatchObject({
      color: LIGHT_COLORS.textSecondary,
    });
    const arrow = screen.UNSAFE_getAllByType(Text).find((text) => text.props.children === '∧');
    expect(StyleSheet.flatten(arrow?.props.style)).toMatchObject({
      color: LIGHT_COLORS.textSecondary,
    });
  });

  test('end 정렬은 말풍선 최대 폭과 오른쪽 눌림 보정을 쓴다', () => {
    const screen = render(
      <CollapsibleCaption title="Jev 후보 1" align="end" initiallyCollapsed={false}>
        <CollapsibleCaptionLine>아주 긴 한 줄 후보 요약</CollapsibleCaptionLine>
      </CollapsibleCaption>,
    );
    const button = screen.getByRole('button', { name: 'Jev 후보 1' });
    const titleRow = screen.UNSAFE_getAllByType(View).find((view) =>
      StyleSheet.flatten(view.props.style).borderRadius === FOUNDATION_RADIUS.chip);
    const contentLine = screen.getByText('아주 긴 한 줄 후보 요약');
    expect(button.props.accessibilityState).toEqual({ expanded: true });
    expect(StyleSheet.flatten(titleRow?.props.style)).toMatchObject({
      alignSelf: 'flex-end',
      marginLeft: 0,
      marginRight: -DESIGN_SPACING.sm,
    });
    expect(StyleSheet.flatten(contentLine.props.style).textAlign).toBe('right');
    expect(contentLine.props.numberOfLines).toBe(1);
  });
});

describe('LabeledDivider', () => {
  test('기존 메타 타이포그래피로 가운데 라벨과 접근성에서 빠진 양쪽 hairline을 렌더한다', () => {
    const longLabel = '이 라벨은 길이가 달라져도 두 선의 가운데를 확인합니다';
    const screen = render(<LabeledDivider label={longLabel} />);
    const label = screen.getByText(longLabel);
    expect(label.props.numberOfLines).toBe(1);
    expect(label.props.ellipsizeMode).toBe('tail');
    expect(StyleSheet.flatten(label.props.style)).toMatchObject({
      flexShrink: 1,
      color: LIGHT_COLORS.textPlaceholder,
      fontSize: TABLET_CHAT_TYPOGRAPHY.meta,
      lineHeight: TABLET_CHAT_TYPOGRAPHY.meta * 1.3,
    });
    const decorativeLines = screen.UNSAFE_getAllByType(View)
      .filter((view) => view.props.accessibilityElementsHidden === true);
    expect(decorativeLines).toHaveLength(2);
    for (const line of decorativeLines) {
      expect(StyleSheet.flatten(line.props.style)).toMatchObject({
        height: StyleSheet.hairlineWidth,
        backgroundColor: LIGHT_COLORS.border,
        flex: 1,
        minWidth: DESIGN_SPACING.xl,
      });
      expect(line.props.importantForAccessibility).toBe('no');
    }
    const row = screen.UNSAFE_getAllByType(View)[0];
    expect(StyleSheet.flatten(row.props.style)).toMatchObject({
      gap: DESIGN_SPACING.md,
      marginVertical: DESIGN_SPACING.xxxl,
      paddingHorizontal: TABLET_SPACING.lg,
    });
  });
});

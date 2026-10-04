jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { CARD_COLORS } from '../../../../../packages/wire-schema/src/card_colors';
import { cardFixture } from '../../../test-support/cards';
import { PostItCard } from '../PostItCard';

test.each([
  ['full', 'pink'],
  ['compact', 'lavender'],
] as const)('%s post-it applies the server palette color %s', (variant, color) => {
  const card = { ...cardFixture(), color };
  const screen = render(<PostItCard api={null} card={card} variant={variant} onOpen={() => {}} />);

  expect(StyleSheet.flatten(screen.getByTestId(`postit-card-${card.id}`).props.style).backgroundColor)
    .toBe(CARD_COLORS[color].hex);
});

test('an older card response without color keeps the yellow paper fallback', () => {
  const card = cardFixture();
  const screen = render(<PostItCard api={null} card={card} onOpen={() => {}} />);

  expect(StyleSheet.flatten(screen.getByTestId(`postit-card-${card.id}`).props.style).backgroundColor)
    .toBe(CARD_COLORS.yellow.hex);
});

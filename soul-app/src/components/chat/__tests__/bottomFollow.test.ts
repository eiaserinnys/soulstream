import {
  bottomFollowTargetKey,
  isNearInvertedListBottom,
  shouldFollowNewBottomItem,
} from '../bottomFollow';

describe('bottomFollow', () => {
  it('treats small inverted-list offsets as being at the bottom', () => {
    expect(isNearInvertedListBottom(0)).toBe(true);
    expect(isNearInvertedListBottom(10)).toBe(true);
    expect(isNearInvertedListBottom(10.1)).toBe(false);
  });

  it('uses the newest render item as the bottom follow target', () => {
    expect(bottomFollowTargetKey([])).toBeNull();
    expect(
      bottomFollowTargetKey([
        { key: 'evt-old' },
        { key: 'tool-use' },
        { key: 'evt-new-assistant' },
      ]),
    ).toBe('evt-new-assistant');
  });

  it('tracks the newest real item when a stable typing indicator is below it', () => {
    expect(
      bottomFollowTargetKey([
        { kind: 'event', key: 'evt-old' },
        { kind: 'typing', key: 'typing-indicator' },
      ]),
    ).toBe('evt-old');

    expect(
      bottomFollowTargetKey([
        { kind: 'tool', key: 'tool-use' },
        { kind: 'typing', key: 'typing-indicator' },
      ]),
    ).toBe('tool-use');

    expect(
      bottomFollowTargetKey([{ kind: 'typing', key: 'typing-indicator' }]),
    ).toBe('typing-indicator');
  });

  it('follows a newly appended bottom item only when the user was at bottom', () => {
    expect(
      shouldFollowNewBottomItem({
        wasAtBottom: true,
        previousKey: 'evt-old',
        nextKey: 'tool-use',
      }),
    ).toBe(true);

    expect(
      shouldFollowNewBottomItem({
        wasAtBottom: false,
        previousKey: 'evt-old',
        nextKey: 'tool-use',
      }),
    ).toBe(false);

    expect(
      shouldFollowNewBottomItem({
        wasAtBottom: true,
        previousKey: 'tool-use',
        nextKey: 'tool-use',
      }),
    ).toBe(false);

    expect(
      shouldFollowNewBottomItem({
        wasAtBottom: true,
        previousKey: null,
        nextKey: 'evt-first',
      }),
    ).toBe(true);
  });
});

import {
  isForegroundAppState,
  shouldRenderSessionCardShimmer,
  shouldRunSessionCardAnimation,
  shouldRunStatusDotAnimation,
} from '../sessionCardAnimation';

describe('SessionCard animation decisions', () => {
  it('only treats active as foreground for repeated animation', () => {
    expect(isForegroundAppState('active')).toBe(true);
    expect(isForegroundAppState('inactive')).toBe(false);
    expect(isForegroundAppState('background')).toBe(false);
  });

  it('runs the Chat StatusDot loop only while running and active', () => {
    expect(shouldRunStatusDotAnimation('running', isForegroundAppState('active'))).toBe(true);
    expect(shouldRunStatusDotAnimation('running', isForegroundAppState('inactive'))).toBe(false);
    expect(shouldRunStatusDotAnimation('running', isForegroundAppState('background'))).toBe(false);
    expect(shouldRunStatusDotAnimation('completed', true)).toBe(false);
  });

  it('runs animation only for running sessions with motion enabled in foreground', () => {
    expect(
      shouldRunSessionCardAnimation({
        isRunning: true,
        reducedMotion: false,
        appActive: true,
      }),
    ).toBe(true);

    expect(
      shouldRunSessionCardAnimation({
        isRunning: false,
        reducedMotion: false,
        appActive: true,
      }),
    ).toBe(false);

    expect(
      shouldRunSessionCardAnimation({
        isRunning: true,
        reducedMotion: true,
        appActive: true,
      }),
    ).toBe(false);

    expect(
      shouldRunSessionCardAnimation({
        isRunning: true,
        reducedMotion: false,
        appActive: false,
      }),
    ).toBe(false);
  });

  it('renders shimmer only after layout width is known and animation is enabled', () => {
    expect(
      shouldRenderSessionCardShimmer({
        isRunning: true,
        reducedMotion: false,
        appActive: true,
        cardWidth: 320,
      }),
    ).toBe(true);

    expect(
      shouldRenderSessionCardShimmer({
        isRunning: true,
        reducedMotion: false,
        appActive: true,
        cardWidth: 0,
      }),
    ).toBe(false);

    expect(
      shouldRenderSessionCardShimmer({
        isRunning: true,
        reducedMotion: false,
        appActive: false,
        cardWidth: 320,
      }),
    ).toBe(false);
  });
});

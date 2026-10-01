import {
  resolveGlassBlurTint,
  resolveGlassSurfaceKind,
} from '../GlassSurface';

describe('resolveGlassBlurTint', () => {
  it('uses the current theme mode when no override is provided', () => {
    expect(resolveGlassBlurTint('light')).toBe('light');
    expect(resolveGlassBlurTint('dark')).toBe('dark');
  });

  it('preserves explicit blur tint overrides', () => {
    expect(resolveGlassBlurTint('dark', 'extraLight')).toBe('extraLight');
    expect(resolveGlassBlurTint('light', 'prominent')).toBe('prominent');
  });
});

describe('resolveGlassSurfaceKind', () => {
  it('Reduce Transparency에서는 native/blur availability와 무관하게 solid다', () => {
    expect(resolveGlassSurfaceKind({
      nativeGlassAvailable: true,
      reduceTransparency: true,
    })).toBe('solid');
    expect(resolveGlassSurfaceKind({
      nativeGlassAvailable: false,
      reduceTransparency: true,
    })).toBe('solid');
  });

  it('일반 모드에서는 native glass 다음 blur 순서로 폴백한다', () => {
    expect(resolveGlassSurfaceKind({
      nativeGlassAvailable: true,
      reduceTransparency: false,
    })).toBe('native');
    expect(resolveGlassSurfaceKind({
      nativeGlassAvailable: false,
      reduceTransparency: false,
    })).toBe('blur');
  });
});

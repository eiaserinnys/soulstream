import fs from 'node:fs';
import path from 'node:path';
import { resolveAppGlassRole } from '../AppGlassCard';

describe('AppGlassCard single route', () => {
  test('canonical과 legacy public role을 한 경계에서 매핑한다', () => {
    expect(resolveAppGlassRole('glassCard')).toBe('glassCard');
    expect(resolveAppGlassRole('card')).toBe('glassCard');
    expect(resolveAppGlassRole('panel')).toBe('glassSoft');
    expect(resolveAppGlassRole('message')).toBe('glassDense');
    expect(resolveAppGlassRole('modal')).toBe('modal');
  });

  test('AppGlassCard는 View 우회 없이 GlassSurface 단일 경로만 쓴다', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../AppGlassCard.tsx'), 'utf8');
    expect(source).toContain('<GlassSurface');
    expect(source).not.toContain('!surface.nativeGlass');
    expect(source).not.toContain('fallbackColor=');
    expect(source).not.toContain('borderRadius=');
    expect(source).not.toContain('blurIntensity=');
  });
});

import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '../..');

describe('N5 settings and adaptive overlay contract', () => {
  test('Settings owns one explicit primary save action and semantic secondary controls', () => {
    const screen = read('screens/SettingsScreen.tsx');
    const connection = read('components/settings/ConnectionSettingsSection.tsx');
    const segments = read('components/settings/SettingsSegmentedControl.tsx');
    const auth = read('components/settings/ClaudeProviderSection.tsx');

    expect(connection.match(/variant="primary"/g) ?? []).toHaveLength(1);
    expect(connection).toContain('testID="settings-save"');
    expect(connection.match(/<GlassButton/g) ?? []).toHaveLength(2);
    expect(segments).toContain('hitTarget:');
    expect(segments).toContain('minHeight: t.hitTarget.min');
    expect(segments).toContain('visual:');
    expect(segments).toContain('minHeight: t.foundation.minHeight.segment');
    expect(connection).toContain('minHeight: t.foundation.minHeight.field');
    expect(connection).not.toMatch(/\bheight:\s*t\.controlHeight\.button/);
    expect(auth).not.toContain('variant="primary"');
  });

  test('sheets and settings modal keep adaptive orientation, safe-area and keyboard boundaries', () => {
    const modalSurface = read('components/AppModalSurface.tsx');
    expect(modalSurface).toContain(
      "'portrait',\n  'portrait-upside-down',\n  'landscape-left',\n  'landscape-right'",
    );
    expect(modalSurface).toContain('<SafeAreaView');
    for (const file of [
      'components/planner/NewFolderSheet.tsx',
      'components/planner/SessionSuccessionSheet.tsx',
      'components/settings/SettingsModal.tsx',
    ]) {
      const source = read(file);
      expect(source).toContain('<AppModalSurface');
      expect(source).not.toMatch(/\bheight:\s*t\.controlHeight\.button/);
    }
    expect(read('components/planner/NewFolderSheet.tsx')).toContain('<AppKeyboardAvoidingView');
    expect(read('components/planner/SessionSuccessionSheet.tsx'))
      .toContain("automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}");
    expect(read('components/settings/SettingsModal.tsx')).toContain('<SettingsScreen flattened');
    for (const file of [
      'components/chat/ChatBody.tsx',
      'components/planner/NewFolderSheet.tsx',
      'screens/SettingsScreen.tsx',
    ]) {
      const source = read(file);
      expect(source).toContain('<AppKeyboardAvoidingView');
      expect(source).not.toMatch(/\bKeyboardAvoidingView\b/);
    }
  });

  test('login and push boundaries expose retry-safe failure handling outside OS-owned prompts', () => {
    const login = read('screens/LoginScreen.tsx');
    const push = read('services/pushNotifications.ts');

    expect(login).toContain("response.type === 'locked'");
    expect(login).toContain('await promptAsync();');
    expect(login).toContain('} catch (cause) {');
    expect(push).toContain("console.warn('[push] registration skipped:'");
    const registerIndex = push.indexOf(
      'await api.registerPushToken({ token: newToken, deviceId });',
    );
    const ledgerIndex = push.indexOf('await AsyncStorage.multiSet(');
    expect(registerIndex).toBeGreaterThan(-1);
    expect(ledgerIndex).toBeGreaterThan(-1);
    expect(registerIndex).toBeLessThan(ledgerIndex);
  });
});

function read(relativePath: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, relativePath), 'utf8');
}

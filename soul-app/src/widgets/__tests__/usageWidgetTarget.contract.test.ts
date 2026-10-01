import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Expo app와 WidgetKit target이 같은 App Group을 사용한다', () => {
  const app = JSON.parse(read('app.json'));
  const packageJson = JSON.parse(read('package.json'));
  const target = read('targets/usage-widget/expo-target.config.js');
  const podPlugin = read('plugins/withExtensionStoragePod.js');

  expect(app.expo.plugins).toContain('@bacons/apple-targets');
  const buildProperties = app.expo.plugins.find(
    (plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-build-properties',
  );

  expect(buildProperties).toEqual([
    'expo-build-properties',
    expect.objectContaining({
      ios: expect.objectContaining({
        deploymentTarget: '16.4',
        buildReactNativeFromSource: true,
      }),
    }),
  ]);
  expect(packageJson.dependencies['expo-build-properties']).toBe('~57.0.21');
  expect(app.expo.plugins).toContain('./plugins/withExtensionStoragePod');
  expect(podPlugin).toContain("pod 'ExtensionStorage'");
  expect(podPlugin).toContain("node_modules/@bacons/apple-targets/ios");
  expect(podPlugin).toContain('`${EXTENSION_STORAGE_POD}\\n${marker}`');
  expect(app.expo.ios.entitlements['com.apple.security.application-groups']).toEqual([
    'group.me.eiaserinnys.soulstream',
  ]);
  expect(target).toContain("type: 'widget'");
  expect(target).toContain("deploymentTarget: '17.0'");
  expect(target).toContain('com.apple.security.application-groups');
});

test('timeline은 자격증명 없음·404·연결 오류를 구분하고 연결 오류만 마지막 성공을 보존한다', () => {
  const provider = [
    read('targets/usage-widget/UsageWidgetProvider.swift'),
    read('targets/usage-widget/UsageWidgetModels.swift'),
  ].join('\n');

  expect(provider).toContain('/api/usage/summary');
  expect(provider).toContain('Authorization');
  expect(provider).toContain('credentialsMissing');
  expect(provider).toContain('serverPending');
  expect(provider).toContain('connectionError');
  expect(provider).toContain('catch UsageFetchError.credentialsMissing');
  expect(provider).toContain('catch UsageFetchError.serverPending');
  expect(provider).toContain('cachedEntry(configuration: configuration, state: .connectionError)');
  expect(provider).toContain('lastSummary');
  expect(provider).toContain('15 * 60');
  expect(provider).toContain('weekly_scoped');
  expect(provider).not.toContain('Codex 5시간');
});

test('위젯은 편집 기본 노드·이전/다음 버튼·small/medium·사용량 딥링크를 함께 제공한다', () => {
  const widget = read('targets/usage-widget/UsageWidget.swift');
  const intents = read('targets/usage-widget/UsageWidgetIntents.swift');

  expect(widget).toContain('AppIntentConfiguration');
  expect(widget).toContain('.systemSmall');
  expect(widget).toContain('.systemMedium');
  expect(widget).toContain('soulstream://usage');
  expect(widget).toContain('.withFractionalSeconds');
  expect(widget).toContain('PreviousUsageNodeIntent');
  expect(widget).toContain('NextUsageNodeIntent');
  expect(intents).toContain('WidgetConfigurationIntent');
  expect(intents).toContain('UsageNodeEntity');
});

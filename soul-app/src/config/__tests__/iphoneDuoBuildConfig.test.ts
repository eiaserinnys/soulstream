import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
const readJson = (relativePath: string) =>
  JSON.parse(readFileSync(resolve(root, relativePath), 'utf8')) as Record<string, any>;

const versionsAtLeast = (declared: string, minimum: number[]) => {
  const parts = declared.replace(/^[~^><=\s]+/, '').split('-')[0].split('.').map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    const value = parts[index] ?? 0;
    if (value > minimum[index]) return true;
    if (value < minimum[index]) return false;
  }
  return true;
};

const allOrientations = [
  'UIInterfaceOrientationPortrait',
  'UIInterfaceOrientationPortraitUpsideDown',
  'UIInterfaceOrientationLandscapeLeft',
  'UIInterfaceOrientationLandscapeRight',
];

test('iPhone orientation allows portrait and landscape while iPad keeps four orientations', () => {
  const app = readJson('app.json');
  const infoPlist = app.expo.ios.infoPlist;

  expect(app.expo.orientation).toBe('default');
  expect(infoPlist.UISupportedInterfaceOrientations).toEqual(allOrientations);
  expect(infoPlist['UISupportedInterfaceOrientations~ipad']).toEqual(
    expect.arrayContaining(allOrientations),
  );
  expect(infoPlist.UIRequiresFullScreen).not.toBe(true);
});

test('production iOS build pins the Xcode 27.1 image', () => {
  const eas = readJson('eas.json');

  expect(eas.build.production.ios.image).toBe('macos-tahoe-26.6-xcode-27.1');
});

test('Expo SDK and React Native keep the SDK 57 contract', () => {
  const pkg = readJson('package.json');

  expect(versionsAtLeast(pkg.dependencies.expo, [57, 0, 24])).toBe(true);
  expect(versionsAtLeast(pkg.dependencies['react-native'], [0, 86, 3])).toBe(true);
});

jest.mock('expo/metro-config', () => ({
  getDefaultConfig: () => ({ resolver: {}, watchFolders: [] }),
}));

const path = require('node:path');

describe('앱 시안 내보내기 설정', () => {
  const previous = process.env.MOCKUP_BASE_URL;
  afterEach(() => {
    if (previous === undefined) delete process.env.MOCKUP_BASE_URL;
    else process.env.MOCKUP_BASE_URL = previous;
    jest.resetModules();
  });

  test('발행 하위 경로를 Expo 설정에 전달한다', () => {
    process.env.MOCKUP_BASE_URL = '/d/mockup-app-proof-343-x9k2';
    expect(require('./mockup/app.config').expo).toEqual({
      name: 'Soulstream 앱 시안', slug: 'soul-app-mockup',
      web: { bundler: 'metro', output: 'single' },
      experiments: { baseUrl: '/d/mockup-app-proof-343-x9k2' },
    });
  });

  test.each([undefined, '', '/', '/assets/ios-components', '/d/', '/d/proof/', '/d/proof/other'])
  ('잘못된 발행 경로 %s는 설정 단계에서 멈춘다', (value) => {
    if (value === undefined) delete process.env.MOCKUP_BASE_URL;
    else process.env.MOCKUP_BASE_URL = value;
    expect(() => require('./mockup/app.config')).toThrow('MOCKUP_BASE_URL');
  });

  test('검수 창과 시안은 같은 소스와 로컬 fixture를 해석한다', () => {
    const review = require('./component-review/metro.config');
    const mockup = require('./mockup/metro.config');
    expect(mockup.watchFolders).toEqual(review.watchFolders);
    expect(mockup.resolver.nodeModulesPaths).toEqual(review.resolver.nodeModulesPaths);
    const client = path.join(__dirname, 'src/api/client.ts');
    for (const config of [review, mockup]) {
      expect(config.resolver.resolveRequest({
        resolveRequest: () => ({ type: 'sourceFile', filePath: client }),
      }, './client', 'web')).toEqual({
        type: 'sourceFile', filePath: path.join(__dirname, 'src/component-review/fixture-client.ts'),
      });
    }
  });
});

jest.mock('expo/metro-config', () => ({
  getDefaultConfig: () => ({ resolver: {} }),
}));

const config = require('./metro.config');

describe('Metro resolver compatibility', () => {
  it('maps react-native-webrtc legacy event-target-shim subpath to the public root', () => {
    const resolved = { type: 'sourceFile', filePath: '/event-target-shim/index.js' };
    const resolveRequest = jest.fn(() => resolved);
    const context = { resolveRequest };

    expect(
      config.resolver.resolveRequest(context, 'event-target-shim/index', 'ios'),
    ).toBe(resolved);
    expect(resolveRequest).toHaveBeenCalledWith(
      context,
      'event-target-shim',
      'ios',
    );
  });

  it('leaves every other module specifier unchanged', () => {
    const resolved = { type: 'sourceFile', filePath: '/react/index.js' };
    const resolveRequest = jest.fn(() => resolved);
    const context = { resolveRequest };

    expect(config.resolver.resolveRequest(context, 'react', 'ios')).toBe(resolved);
    expect(resolveRequest).toHaveBeenCalledWith(context, 'react', 'ios');
  });
});

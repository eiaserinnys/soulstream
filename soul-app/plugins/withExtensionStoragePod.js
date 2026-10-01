const { withPodfile } = require('@expo/config-plugins');

const EXTENSION_STORAGE_POD =
  "  pod 'ExtensionStorage', :path => '../node_modules/@bacons/apple-targets/ios'";

/**
 * @bacons/apple-targets 5.0.0의 target 생성 플러그인은 유지하되, EAS production에서
 * 누락됐던 ExtensionStorage pod를 앱 target에 명시적으로 고정한다.
 */
module.exports = function withExtensionStoragePod(config) {
  return withPodfile(config, (podfileConfig) => {
    const contents = podfileConfig.modResults.contents;
    if (contents.includes(EXTENSION_STORAGE_POD)) return podfileConfig;

    const marker = '  use_expo_modules!';
    if (!contents.includes(marker)) {
      throw new Error('ExtensionStorage pod를 추가할 use_expo_modules! 위치를 찾지 못했습니다.');
    }
    podfileConfig.modResults.contents = contents.replace(
      marker,
      `${EXTENSION_STORAGE_POD}\n${marker}`,
    );
    return podfileConfig;
  });
};

/** @type {import('jest').Config} */
// Some CI/agent shells may export NODE_ENV=production. Force test mode before
// jest-expo and React Native load their module graph.
process.env.NODE_ENV = 'test';

module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  // Shared workspace packages resolve their dependencies from the app install.
  modulePaths: ['<rootDir>/node_modules'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/.expo/',
    '/android/',
    '/ios/',
    '/src/navigation/__tests__/navigationCaptureMock\\.tsx$',
  ],
  // jest-expo가 RN 트리의 일부만 변환하므로, 앱이 실제로 사용하는 RN 패키지를
  // 화이트리스트에 명시해야 한다 (package.json dependencies와 대조하여 유지).
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@react-navigation/.*|react-native-markdown-display|react-native-enriched-markdown|react-native-webview|@react-native-async-storage|expo-asset|expo-file-system|expo-secure-store|expo-status-bar|expo-web-browser|expo-clipboard|expo-crypto|expo-document-picker|expo-image-picker|expo-modules-core|react-native-gesture-handler|react-native-screens|react-native-safe-area-context|react-native-sse|react-native-reanimated|expo-blur|expo-glass-effect|expo-linear-gradient|zustand)/)',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
};

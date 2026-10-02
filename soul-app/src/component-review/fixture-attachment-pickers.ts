import { Asset } from 'expo-asset';

// Native OS picker simulation only. The operational hook and upload API fixture
// run unchanged; this is not evidence of photo-library permission on iOS.
export const ActionSheetIOS = {
  showActionSheetWithOptions: (_options: unknown, callback: (index: number) => void) => callback(0),
};
export const ImagePicker = {
  requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
  launchImageLibraryAsync: async () => ({ canceled: false, assets: [{
    uri: Asset.fromModule(require('../../assets/icon.png')).uri,
    fileName: '공개 예시 사진.png', mimeType: 'image/png',
  }] }),
};
export const DocumentPicker = {
  getDocumentAsync: async () => ({ canceled: true, assets: [] }),
};

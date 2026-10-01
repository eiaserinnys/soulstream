import AsyncStorage from '@react-native-async-storage/async-storage';
import { withDiagnosticStateStorage } from './diagnosticStateStorage';
export const settingsStorage = withDiagnosticStateStorage(AsyncStorage, 'settings');

import { registerRootComponent } from 'expo';
import './src/lib/install-eas-observe-crash-reporting';
import { startSessionDiagnostics } from './src/lib/session-diagnostics';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
startSessionDiagnostics();

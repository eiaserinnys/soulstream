import {
  dispatchEasObserveEvents,
  logEasObserveEvent,
  installEasObserveCrashReporting,
} from './eas-observe-crash-reporting';

// This module is imported by index.ts before App. Keep the installation as an
// import-time side effect so the App dependency graph cannot run first.
installEasObserveCrashReporting();

export {
  dispatchEasObserveEvents,
  logEasObserveEvent,
};

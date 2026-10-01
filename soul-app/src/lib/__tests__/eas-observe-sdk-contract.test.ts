import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
const readInstalledSource = (relativePath: string) =>
  readFileSync(resolve(root, 'node_modules', relativePath), 'utf8');

test('installed Observe SDK retains the checked global-error seam', () => {
  const observeIndex = readInstalledSource('expo-observe/src/index.ts');
  const caughtErrorReporter = readInstalledSource('expo-observe/src/reportCaughtError.ts');
  const appMetricsTypes = readInstalledSource('expo-app-metrics/src/types.ts');

  expect(observeIndex).toContain("export { default as AppMetrics } from 'expo-app-metrics';");
  expect(caughtErrorReporter).toContain("source: 'reportedByUser'");
  expect(caughtErrorReporter).toContain('isFatal: false');
  expect(appMetricsTypes).toContain("source: 'global' | 'errorBoundary' | 'reportedByUser';");
  expect(appMetricsTypes).toContain('isFatal: boolean;');
});

test('installed Observe SDK lets public startup dispatch drain persisted logs', () => {
  const observeTypes = readInstalledSource('expo-observe/src/types.ts');
  const observeModule = readInstalledSource('expo-observe/ios/ObserveModule.swift');
  const observability = readInstalledSource('expo-observe/ios/Observability.swift');
  const appMetricsTypes = readInstalledSource('expo-app-metrics/src/types.ts');
  const appMetricsModule = readInstalledSource('expo-app-metrics/ios/AppMetricsModule.swift');
  const session = readInstalledSource('expo-app-metrics/ios/Sessions/Session.swift');
  const bodyValidation = readInstalledSource('expo-app-metrics/ios/LogEvents/EventBodyValidation.swift');
  const attributeValidation = readInstalledSource('expo-app-metrics/ios/LogEvents/AttributeValidation.swift');

  expect(observeTypes).toContain('dispatchEvents(): Promise<void>;');
  expect(observeTypes).toMatch(/logEvent\(name: string, options\?: LogEventOptions\): void;/);
  expect(observeModule).toContain('AsyncFunction("dispatchEvents")');
  expect(observeModule).toContain('await ObservabilityManager.dispatch()');
  expect(observability).toContain('await dispatchLogs(shouldDispatch: shouldDispatch)');
  expect(observability).toContain('let logs = try AppMetrics.getLogs(afterId: cursor, limit: limit)');
  expect(appMetricsTypes).toMatch(/logEvent\(name: string, options\?: LogEventOptions\): void;/);
  expect(appMetricsModule).toContain('AppMetrics.mainSession.receiveLog(record)');
  expect(session).toContain('AppMetrics.database?.insert(log: LogRow.from(log: log, sessionId: self.id))');
  expect(session).toContain('logger.warn(');
  expect(bodyValidation).toContain('private let maxEventBodyLength = 4096');
  expect(appMetricsTypes).toContain('attributes?: Record<string, LogAttributeValue> | null;');
  expect(attributeValidation).toContain('private let maxAttributeCount = 128');

  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  expect(packageJson.scripts['diagnostics:ios-errors']).toContain('--platform apple');
  expect(packageJson.scripts['diagnostics:ios-error-fingerprint']).toContain('--platform apple');
  expect(packageJson.scripts['diagnostics:ios-observe-versions']).toContain('--platform apple');
  expect(packageJson.scripts['diagnostics:ios-session-reports']).toContain('--platform apple');
});

test('only the internal verification profile enables a safe prior-run diagnostic marker', () => {
  const eas = JSON.parse(readFileSync(resolve(root, 'eas.json'), 'utf8'));

  expect(eas.build.production).toMatchObject({ uploadSourceMaps: true });
  expect(eas.build.production.buildArtifactPaths).toEqual(['ios/build/*.dSYM.zip']);
  expect(eas.build.production.env?.EXPO_PUBLIC_EAS_OBSERVE_SYNTHETIC_TEST).toBeUndefined();
  expect(eas.build.production.env?.EXPO_PUBLIC_SESSION_DIAGNOSTICS_VERIFY).toBeUndefined();
  expect(eas.build['observe-verification']).toEqual(
    expect.objectContaining({
      extends: 'production',
      distribution: 'internal',
      env: { EXPO_PUBLIC_SESSION_DIAGNOSTICS_VERIFY: '1' },
    }),
  );
});

test('native diagnostics outbox and main-thread probe are fixed-size and foreground-only', () => {
  const nativeModule = readFileSync(
    resolve(root, 'modules/soul-app-session-diagnostics/ios/SoulAppSessionDiagnosticsModule.swift'),
    'utf8',
  );

  expect(nativeModule).toContain('private static let maxRecords = 64');
  expect(nativeModule).toContain('private static let maxFileBytes = 16 * 1024');
  expect(nativeModule).toContain('private static let maxRecordAgeMs: Double = 72 * 60 * 60 * 1000');
  expect(nativeModule).toContain('private static let maxStackFrames = 16');
  expect(nativeModule).toContain('private static let maxCrashStackFrames = 20');
  expect(nativeModule).toContain('stackTruncated: stack.truncated');
  expect(nativeModule).toContain('"offsetIntoBinaryTextSegment"');
  expect(nativeModule).toContain('frame["binaryUUID"]');
  expect(nativeModule).toContain('private static func binaryUuid(_ value: Any?) -> String?');
  expect(nativeModule).toContain('Bundle.main.infoDictionary?["CFBundleExecutable"]');
  expect(nativeModule).toContain('safeOsVersion(hang.metaData.osVersion)');
  expect(nativeModule).toContain('for crash in payload.crashDiagnostics ?? []');
  expect(nativeModule).toContain('kind: "native_crash"');
  expect(nativeModule).toContain('crash.terminationReason');
  expect(nativeModule).toContain('crash.exceptionType?.intValue');
  expect(nativeModule).toContain('crash.signal?.intValue');
  expect(nativeModule).toContain('crash.callStackTree.jsonRepresentation()');
  expect(nativeModule).toContain('value.components(separatedBy: .newlines).first ?? value');
  expect(nativeModule).toContain('[A-Za-z0-9 _.,:;()/+\\\\-<>|=@]+');
  expect(nativeModule).toContain('var isProtectedDiagnostic: Bool');
  expect(nativeModule).toContain('nextRecords.firstIndex { !$0.isProtectedDiagnostic } ?? 0');
  expect(nativeModule).toContain('timestampMs < cutoffMs && !$0.isProtectedDiagnostic');
  expect(nativeModule).toContain('value.hasPrefix("libswift")');
  expect(nativeModule).toContain('value.hasPrefix("libobjc")');
  expect(nativeModule).toContain('[0-9]{1,3}');
  expect(nativeModule).toContain('{1,16}');
  expect(nativeModule).toContain('guard probeActive, isForegroundActive() else { return }');
  expect(nativeModule).toContain('outstandingProbe == nil, pendingMainProbeId == nil');
  const stopProbe = nativeModule.split('func stopMainThreadProbe() {')[1]?.split('\n  func didReceive')[0];
  expect(stopProbe).toBeDefined();
  expect(stopProbe).not.toContain('pendingMainProbeId = nil');
  expect(nativeModule).toContain('let idsToRemove = Set(ids)');
  expect(nativeModule).toContain('nextRecords.removeAll { idsToRemove.contains($0.id) }');
  expect(nativeModule).toContain('try data.write(to: storageURL, options: .atomic)');
});

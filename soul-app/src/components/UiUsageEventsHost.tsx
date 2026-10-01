import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { decodeAuthJwt } from '../auth/jwt-payload';
import { captureAuthScope } from '../lib/auth-scope';
import { UiUsageEvents, uiUsageEvents } from '../lib/ui-usage-events';
import { measureDiagnosticOperation } from '../lib/session-diagnostics-api';

/** 인증된 앱 수명 안에서만 UI 사용 로그를 켠다. */
export function UiUsageEventsHost({
  generation,
  events = uiUsageEvents,
  onCollectionEnabled,
}: {
  generation: string;
  events?: UiUsageEvents;
  onCollectionEnabled?: () => void;
}) {
  const collectionEnabledRef = useRef(false);
  const onCollectionEnabledRef = useRef(onCollectionEnabled);

  useEffect(() => {
    onCollectionEnabledRef.current = onCollectionEnabled;
  }, [onCollectionEnabled]);

  useEffect(() => {
    collectionEnabledRef.current = false;
    const scope = captureAuthScope();
    const profile = decodeAuthJwt(scope.jwt);
    if (!profile) {
      events.stop();
      return;
    }
    let disposed = false;
    void measureDiagnosticOperation('usage_storage', 20, () => events.start(scope, profile.email)).then((enabled) => {
      if (disposed || !enabled) return;
      if (events.record({ type: 'app_active', attrs: { reason: 'launch' } })) {
        collectionEnabledRef.current = true;
        onCollectionEnabledRef.current?.();
      }
      void measureDiagnosticOperation('usage_storage', 23, () => events.flush());
    });
    return () => {
      disposed = true;
      collectionEnabledRef.current = false;
      events.stop();
    };
  }, [generation, events]);

  useEffect(() => {
    let wasBackgrounded = AppState.currentState === 'background';
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'background') {
        wasBackgrounded = true;
        void measureDiagnosticOperation('usage_storage', 21, () => events.onAppInactive());
        return;
      }
      if (next === 'active' && wasBackgrounded) {
        wasBackgrounded = false;
        void measureDiagnosticOperation('usage_storage', 22, () => events.onAppActive()).then((enabled) => {
          if (!enabled) {
            collectionEnabledRef.current = false;
            return;
          }
          if (!collectionEnabledRef.current) {
            collectionEnabledRef.current = true;
            onCollectionEnabledRef.current?.();
          }
        });
      }
    });
    return () => subscription.remove();
  }, [events]);

  return null;
}

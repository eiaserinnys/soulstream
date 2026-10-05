// react-native-reanimated는 native worklet runtime에 의존하므로 Jest에서는 첫 프레임의
// 정적 style만 계산한다. 4.1 공식 mock은 useFrameCallback이 없고 worklets ESM을 직접
// import하므로 jest-expo 54에서 파싱되지 않는다.
jest.mock('react-native-reanimated', () => {
  const { Animated } = require('react-native');
  return {
    __esModule: true,
    default: Animated,
    useSharedValue: (initialValue) => require('react').useRef({ value: initialValue }).current,
    useAnimatedStyle: (updater) => updater(),
    // GestureDetector still initializes this hook for runOnJS gestures.
    useEvent: (callback) => callback,
    runOnJS: (callback) => callback,
    useFrameCallback: jest.fn(),
    interpolateColor: (_value, _inputRange, outputRange) => outputRange[0],
    interpolate: (value, [start, end], [from, to]) => from + (to - from) * (value - start) / (end - start),
    withTiming: jest.fn((value) => value),
    withRepeat: jest.fn(() => 0),
    cancelAnimation: jest.fn(),
    Easing: require('react-native').Easing,
  };
});

// expo-glass-effect는 Jest의 iOS preset에서 native view manager를 찾으며 경고를 낸다.
// 기본 계약은 미지원 View로 두고, native/availability 분기 테스트만 파일 로컬 mock으로 덮는다.
jest.mock('expo-glass-effect', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    GlassView: (props) => React.createElement(View, props),
    isLiquidGlassAvailable: () => false,
    isGlassEffectAPIAvailable: () => false,
  };
});

// Ionicons loads expo-font's ESM entrypoint, which Jest leaves untransformed. The
// component-level tests observe icon names and sizes through this host component.
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

// UI 사용 로그가 runtime build version을 읽는다. jest-expo 54의 ESM Constants 진입점은
// 일부 단위 테스트에서 변환 대상 밖으로 남으므로, 테스트에는 고정된 native metadata를 준다.
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    nativeAppVersion: '1.0.0',
    nativeBuildVersion: '51',
    expoConfig: { version: '1.0.0' },
  },
}));

// AccessibilityInfo.isReduceMotionEnabled — jest-expo가 기본 mock을 제공하지 않아
// SessionCard의 reduced-motion 게이트 테스트가 깨진다. 'react-native' 모듈에 직접 patch한다.
// RN 0.81+에서는 export 경로가 환경마다 달라 sub-path mock이 불안정 — top-level patch가 안전.
{
  const RN = require('react-native');
  RN.AccessibilityInfo = {
    ...RN.AccessibilityInfo,
    isReduceMotionEnabled: jest.fn(() => Promise.resolve(false)),
    // General render tests must not schedule an unobserved async state update. GlassSurface's
    // focused lifecycle suite replaces this with deterministic resolved promises.
    isReduceTransparencyEnabled: jest.fn(() => new Promise(() => {})),
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  };
}

// AppState — react-native/jest/setup.js가 'Libraries/AppState/AppState'를
// 'jest/mocks/AppState'로 통째로 swap하여 currentState가 jest.fn()이 된다.
// 'react-native' top-level의 RN.AppState를 덮어써도 SessionCard의 ESM import는
// swap된 모듈을 직접 참조하므로 효과가 없다 → mock 모듈 자체를 mutate한다.
// 등록된 'change' 콜백을 globalThis.__appStateListeners로 노출하여 테스트가
// 'background'/'active' 전이를 수동 발화할 수 있게 한다.
{
  const AppStateMock =
    require('react-native/Libraries/AppState/AppState').default;
  globalThis.__appStateListeners = [];
  AppStateMock.currentState = 'active';
  AppStateMock.addEventListener = jest.fn((type, fn) => {
    if (type === 'change') globalThis.__appStateListeners.push(fn);
    return {
      remove: () => {
        globalThis.__appStateListeners =
          globalThis.__appStateListeners.filter((l) => l !== fn);
      },
    };
  });
}

// AsyncStorage — settingsStore/sessionStore의 zustand persist가 의존. 라이브러리가 제공하는
// in-memory mock을 사용하면 모든 메서드가 Promise<void>로 동작한다.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// react-native-safe-area-context — useSafeAreaInsets가 SafeAreaProvider 없이 호출되면 throw.
// 라이브러리가 제공하는 공식 mock을 사용하여 모든 inset이 0인 상태를 반환하도록 치환한다.
// 공식 mock은 default export로 객체 전체를 노출하므로 .default를 풀어 named exports로 매핑.
jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default,
);

// react-native-webview는 native TurboModule을 요구한다. Jest에서는 HTML payload와
// testID만 관찰 가능한 View로 바꿔 보드 custom view/asset 렌더 계약을 검증한다.
jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    WebView: (props) => React.createElement(View, {
      ...props,
      accessibilityLabel: props.source?.html,
    }),
  };
});

// react-native-sse는 네이티브 브릿지(XMLHttpRequest 패치 등)에
// 의존하므로 jest 환경에서 직접 import하면 실패한다. EventSource를 가짜 클래스로 치환하고,
// 테스트가 'open' / 'error' / named event를 수동 발화할 수 있도록 헬퍼를 노출한다.
// 마지막으로 생성된 인스턴스는 globalThis.__lastSSEInstance로 접근 가능.
jest.mock('react-native-sse', () => {
  class FakeEventSource {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.listeners = {}; // type -> [fn,...]
      this.closed = false;
      globalThis.__lastSSEInstance = this;
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    removeEventListener(type, fn) {
      if (!this.listeners[type]) return;
      this.listeners[type] = this.listeners[type].filter((listener) => listener !== fn);
    }
    removeAllEventListeners() {
      this.listeners = {};
    }
    close() {
      this.closed = true;
    }
    // 테스트 헬퍼 — 프로덕션 EventSource API에는 없는 발화 메서드.
    triggerOpen() {
      (this.listeners['open'] ?? []).forEach((fn) => fn({ type: 'open' }));
    }
    triggerError(payload = {}) {
      (this.listeners['error'] ?? []).forEach((fn) =>
        fn({ type: 'error', ...payload }),
      );
    }
    triggerEvent(type, data, lastEventId = '') {
      (this.listeners[type] ?? []).forEach((fn) =>
        fn({ type, data: JSON.stringify(data), lastEventId }),
      );
    }
  }
  return { __esModule: true, default: FakeEventSource };
});

// globalThis로 mock 상태를 노출하는 테스트가 서로 누수되지 않도록 정본 한 곳에서 정리한다.
// (테스트별 beforeEach 분산 → setup 한 곳으로 일원화)
afterEach(() => {
  delete globalThis.__lastSSEInstance;
  // AppState 리스너는 mock 자체를 다음 테스트로 가져가되, 등록된 콜백 누수만 방지.
  globalThis.__appStateListeners = [];
});

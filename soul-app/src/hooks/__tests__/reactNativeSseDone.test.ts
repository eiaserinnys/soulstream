jest.unmock('react-native-sse');

import EventSource from 'react-native-sse';

class FakeXMLHttpRequest {
  static readonly UNSENT = 0;
  static readonly OPENED = 1;
  static readonly HEADERS_RECEIVED = 2;
  static readonly LOADING = 3;
  static readonly DONE = 4;
  static instances: FakeXMLHttpRequest[] = [];

  readyState = FakeXMLHttpRequest.UNSENT;
  status = 200;
  responseText = '';
  timeout = 0;
  onreadystatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeXMLHttpRequest.instances.push(this);
  }

  open() {}
  setRequestHeader() {}
  send() {}
  abort() {}
}

const originalXMLHttpRequest = globalThis.XMLHttpRequest;

beforeEach(() => {
  jest.useFakeTimers();
  FakeXMLHttpRequest.instances = [];
  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    writable: true,
    value: FakeXMLHttpRequest,
  });
});

afterEach(() => {
  jest.useRealTimers();
  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    writable: true,
    value: originalXMLHttpRequest,
  });
});

test('200 응답이 LOADING에서 DONE으로 끝나면 done을 한 번 dispatch하고 자동 재개방하지 않는다', () => {
  const source = new EventSource('https://example.test/events', {
    timeoutBeforeConnection: 0,
    pollingInterval: 0,
  });
  const done = jest.fn();
  (source.addEventListener as any)('done', done);
  jest.advanceTimersByTime(0);

  const xhr = FakeXMLHttpRequest.instances[0];
  xhr.readyState = FakeXMLHttpRequest.LOADING;
  xhr.responseText = ': keepalive\n\n';
  xhr.onreadystatechange?.();
  xhr.readyState = FakeXMLHttpRequest.DONE;
  xhr.onreadystatechange?.();

  expect(done).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(30000);
  expect(FakeXMLHttpRequest.instances).toHaveLength(1);
  source.close();
});

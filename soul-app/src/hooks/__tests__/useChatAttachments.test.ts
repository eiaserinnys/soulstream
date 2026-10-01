import { ActionSheetIOS, Alert } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useChatAttachments } from '../useChatAttachments';

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-image-picker', () => ({
  MediaTypeOptions: { All: 'All' },
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test('offline disabled이면 ActionSheet와 direct upload 모두 race-safe no-op이다', async () => {
  const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(jest.fn());
  const api = { uploadAttachment: jest.fn() };
  const { result } = renderHook(() => useChatAttachments({
    api: api as never,
    sessionId: 'session',
    nodeId: 'node-a',
    disabled: true,
  }));

  act(() => result.current.pickAttachment());
  await act(async () => result.current.uploadAttachment({ uri: 'file://x', name: 'x' }));
  expect(sheet).not.toHaveBeenCalled();
  expect(api.uploadAttachment).not.toHaveBeenCalled();
});

test('ActionSheet가 열린 뒤 offline이면 사진·파일 callback이 OS UI와 upload를 모두 차단한다', async () => {
  let callback: ((index: number) => void | Promise<void>) | undefined;
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
    .mockImplementation((_options, cb) => { callback = cb; });
  const api = { uploadAttachment: jest.fn() };
  const { result, rerender } = renderHook(
    ({ disabled }: { disabled: boolean }) => useChatAttachments({
      api: api as never,
      sessionId: 'session',
      nodeId: 'node-a',
      disabled,
    }),
    { initialProps: { disabled: false } },
  );

  act(() => result.current.pickAttachment());
  rerender({ disabled: true });
  await act(async () => callback?.(0));
  await act(async () => callback?.(1));

  expect(ImagePicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
  expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
  expect(DocumentPicker.getDocumentAsync).not.toHaveBeenCalled();
  expect(api.uploadAttachment).not.toHaveBeenCalled();
});

test('permission·picker await 중 offline 전환도 후속 OS UI와 upload를 차단한다', async () => {
  let callback: ((index: number) => void | Promise<void>) | undefined;
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
    .mockImplementation((_options, cb) => { callback = cb; });
  const permission = deferred<{ granted: boolean }>();
  const image = deferred<{ canceled: boolean; assets: Array<{ uri: string; fileName: string }> }>();
  const document = deferred<{ canceled: boolean; assets: Array<{ uri: string; name: string }> }>();
  jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockReturnValue(permission.promise as never);
  jest.mocked(ImagePicker.launchImageLibraryAsync).mockReturnValue(image.promise as never);
  jest.mocked(DocumentPicker.getDocumentAsync).mockReturnValue(document.promise as never);
  const api = { uploadAttachment: jest.fn() };
  const { result, rerender } = renderHook(
    ({ disabled }: { disabled: boolean }) => useChatAttachments({
      api: api as never,
      sessionId: 'session',
      nodeId: 'node-a',
      disabled,
    }),
    { initialProps: { disabled: false } },
  );

  act(() => result.current.pickAttachment());
  let photoPromise!: Promise<void>;
  act(() => { photoPromise = Promise.resolve(callback?.(0)); });
  rerender({ disabled: true });
  await act(async () => permission.resolve({ granted: true }));
  await act(async () => photoPromise);
  expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();

  rerender({ disabled: false });
  act(() => result.current.pickAttachment());
  act(() => { photoPromise = Promise.resolve(callback?.(0)); });
  await act(async () => permission.resolve({ granted: true }));
  await waitForCall(ImagePicker.launchImageLibraryAsync);
  rerender({ disabled: true });
  await act(async () => image.resolve({
    canceled: false,
    assets: [{ uri: 'file://photo', fileName: 'photo.jpg' }],
  }));
  await act(async () => photoPromise);
  expect(api.uploadAttachment).not.toHaveBeenCalled();

  rerender({ disabled: false });
  act(() => result.current.pickAttachment());
  let documentPromise!: Promise<void>;
  act(() => { documentPromise = Promise.resolve(callback?.(1)); });
  rerender({ disabled: true });
  await act(async () => document.resolve({
    canceled: false,
    assets: [{ uri: 'file://document', name: 'document.txt' }],
  }));
  await act(async () => documentPromise);
  expect(api.uploadAttachment).not.toHaveBeenCalled();
});

test('picker 문구·취소·권한 거부·오류 계약을 보존한다', async () => {
  let callback: ((index: number) => void) | undefined;
  const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
    .mockImplementation((options, cb) => { callback = cb; return options as never; });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValue({ granted: false } as never);
  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: true, assets: null } as never);
  const { result } = renderHook(() => useChatAttachments({
    api: { uploadAttachment: jest.fn() } as never,
    sessionId: 'session',
    nodeId: 'node-a',
  }));

  act(() => result.current.pickAttachment());
  expect(sheet.mock.calls[0][0]).toMatchObject({
    options: ['사진/동영상 선택', '파일 선택', '취소'],
    cancelButtonIndex: 2,
    title: '첨부',
  });
  await act(async () => callback?.(0));
  expect(alert).toHaveBeenCalledWith('권한 필요', '사진 라이브러리 접근 권한을 허용해주세요.');
  alert.mockClear();
  await act(async () => callback?.(1));
  expect(alert).not.toHaveBeenCalled();
});

test('사진·파일 선택기 진행 중 uploading을 유지하고 취소 시 해제한다', async () => {
  let callback: ((index: number) => void | Promise<void>) | undefined;
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
    .mockImplementation((_options, cb) => { callback = cb; });
  const permission = deferred<{ granted: boolean }>();
  const image = deferred<{ canceled: boolean; assets: Array<{ uri: string; fileName: string }> }>();
  jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockReturnValue(permission.promise as never);
  jest.mocked(ImagePicker.launchImageLibraryAsync).mockReturnValue(image.promise as never);
  const { result } = renderHook(() => useChatAttachments({
    api: { uploadAttachment: jest.fn() } as never,
    sessionId: 'session',
    nodeId: 'node-a',
  }));

  act(() => result.current.pickAttachment());
  let selectionPromise!: Promise<void>;
  act(() => { selectionPromise = Promise.resolve(callback?.(0)); });
  expect(result.current.uploading).toBe(true);

  await act(async () => permission.resolve({ granted: true }));
  await waitForCall(ImagePicker.launchImageLibraryAsync);
  expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith({
    mediaTypes: ['images', 'videos'],
    quality: 0.9,
    shouldDownloadFromNetwork: true,
  });
  expect(result.current.uploading).toBe(true);

  await act(async () => image.resolve({ canceled: true, assets: [] }));
  await act(async () => selectionPromise);
  expect(result.current.uploading).toBe(false);
});

test('권한 요청과 사진·파일 선택기 reject는 첨부 실패 경고로 알린다', async () => {
  let callback: ((index: number) => void | Promise<void>) | undefined;
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
    .mockImplementation((_options, cb) => { callback = cb; });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  const { result } = renderHook(() => useChatAttachments({
    api: { uploadAttachment: jest.fn() } as never,
    sessionId: 'session',
    nodeId: 'node-a',
  }));

  const invoke = async (index: number) => {
    act(() => result.current.pickAttachment());
    let selectionPromise!: Promise<void>;
    act(() => { selectionPromise = Promise.resolve(callback?.(index)); });
    await act(async () => selectionPromise);
    expect(result.current.uploading).toBe(false);
  };

  jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync)
    .mockRejectedValueOnce(new Error('permission failed'));
  await invoke(0);
  expect(alert).toHaveBeenCalledWith('첨부 실패', 'permission failed');

  alert.mockClear();
  jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync)
    .mockResolvedValueOnce({ granted: true } as never);
  jest.mocked(ImagePicker.launchImageLibraryAsync)
    .mockRejectedValueOnce(new Error('image picker failed'));
  await invoke(0);
  expect(alert).toHaveBeenCalledWith('첨부 실패', 'image picker failed');

  alert.mockClear();
  jest.mocked(DocumentPicker.getDocumentAsync)
    .mockRejectedValueOnce(new Error('file picker failed'));
  await invoke(1);
  expect(alert).toHaveBeenCalledWith('첨부 실패', 'file picker failed');
});

test('업로드 오류는 기존 첨부 실패 Alert 문구를 보존한다', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  const api = { uploadAttachment: jest.fn().mockRejectedValue(new Error('upload failed')) };
  const { result } = renderHook(() => useChatAttachments({
    api: api as never,
    sessionId: 'session',
    nodeId: 'node-a',
  }));

  await act(async () => result.current.uploadAttachment({ uri: 'file://x', name: 'x' }));

  expect(alert).toHaveBeenCalledWith('첨부 실패', 'upload failed');
  expect(result.current.uploading).toBe(false);
});

test('복원 첨부를 현재 목록 앞에 되돌린다', async () => {
  const api = { uploadAttachment: jest.fn().mockResolvedValue({ path: '/new-file.png' }) };
  const { result } = renderHook(() => useChatAttachments({
    api: api as never,
    sessionId: 'session',
    nodeId: 'node-a',
  }));

  await act(async () => result.current.uploadAttachment({
    uri: 'file://new-file.png',
    name: 'new-file.png',
  }));
  act(() => result.current.restoreAttachments([{ path: '/old-file.pdf', name: 'old-file.pdf' }]));

  expect(result.current.attachments).toEqual([
    { path: '/old-file.pdf', name: 'old-file.pdf' },
    { path: '/new-file.png', name: 'new-file.png' },
  ]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function waitForCall(mock: jest.MockedFunction<any>) {
  await act(async () => {
    while (mock.mock.calls.length === 0) await Promise.resolve();
  });
}

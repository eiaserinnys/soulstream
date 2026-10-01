import { File } from 'expo-file-system';

/** 기기 로컬 파일 참조. ImagePicker·DocumentPicker 결과의 `uri`를 그대로 받는다. */
export interface NativeUploadFile {
  uri: string;
  name: string;
  type?: string;
}

/**
 * multipart FormData에 기기 로컬 파일을 붙인다.
 *
 * 앱 전역 fetch는 Expo fetch(SDK 57+)이고, 전송 직전 `convertFormDataAsync`가 조각을
 * 직렬화한다. 이 변환기는 string·Blob·`bytes()`를 가진 객체만 받고 React Native식
 * `{ uri, name, type }` 조각은 'Unsupported FormDataPart implementation'으로 거부한다.
 * 그래서 expo-file-system `File`에서 바이트를 읽는 조각으로 바꿔 붙인다.
 *
 * 이름·MIME은 호출자 값(피커의 원본 파일명 등)을 우선하고, 없으면 파일 시스템 값을 쓴다.
 * multipart Content-Type과 boundary는 fetch가 붙이므로 여기서 지정하지 않는다.
 */
export function appendNativeUploadFile(
  form: FormData,
  field: string,
  file: NativeUploadFile,
): void {
  const source = new File(file.uri);
  const part = {
    name: file.name || source.name,
    type: file.type || source.type || 'application/octet-stream',
    bytes: () => source.bytes(),
  };
  // FormData 타입은 Blob만 받지만, Expo 변환기는 bytes()를 가진 조각을 그대로 전송한다.
  form.append(field, part as unknown as Blob);
}

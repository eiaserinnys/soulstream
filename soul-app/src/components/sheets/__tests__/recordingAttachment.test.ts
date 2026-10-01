import {
  audioMimeType,
  buildRecordingUploadInput,
  extensionFromUri,
  recordingFileName,
} from '../recordingAttachment';

describe('recordingAttachment', () => {
  test('extracts the audio extension from a URI and ignores query params', () => {
    expect(extensionFromUri('file:///tmp/clip.webm?token=abc')).toBe('.webm');
    expect(extensionFromUri('file:///tmp/clip.WAV')).toBe('.WAV');
    expect(extensionFromUri('file:///tmp/clip-without-extension')).toBe('.m4a');
  });

  test('maps known recording extensions to the upload MIME type', () => {
    expect(audioMimeType('.webm')).toBe('audio/webm');
    expect(audioMimeType('.wav')).toBe('audio/wav');
    expect(audioMimeType('.caf')).toBe('audio/x-caf');
    expect(audioMimeType('.m4a')).toBe('audio/mp4');
    expect(audioMimeType('.mp4')).toBe('audio/mp4');
    expect(audioMimeType('.unknown')).toBe('audio/mp4');
  });

  test('builds the same timestamped upload name used by new session recordings', () => {
    const now = new Date('2026-05-24T05:22:33.456Z');

    expect(recordingFileName('.caf', now)).toBe(
      'recording-2026-05-24T05-22-33-456Z.caf',
    );
    expect(
      buildRecordingUploadInput('file:///tmp/voice.caf?cache=1', now),
    ).toEqual({
      uri: 'file:///tmp/voice.caf?cache=1',
      name: 'recording-2026-05-24T05-22-33-456Z.caf',
      type: 'audio/x-caf',
    });
  });
});

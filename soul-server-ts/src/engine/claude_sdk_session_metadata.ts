export interface ClaudeSdkSessionMetadata {
  sessionId: string;
}

const CLAUDE_SDK_SESSION_METADATA = Symbol("claudeSdkSessionMetadata");

export function attachClaudeSdkSessionMetadata(
  target: object,
  metadata: ClaudeSdkSessionMetadata,
): void {
  Object.defineProperty(target, CLAUDE_SDK_SESSION_METADATA, {
    value: Object.freeze({ ...metadata }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

export function readClaudeSdkSessionMetadata(
  target: object,
): ClaudeSdkSessionMetadata | undefined {
  return (target as Record<symbol, ClaudeSdkSessionMetadata | undefined>)[
    CLAUDE_SDK_SESSION_METADATA
  ];
}

export function copyClaudeSdkSessionMetadata(source: object, target: object): void {
  const metadata = readClaudeSdkSessionMetadata(source);
  if (metadata) attachClaudeSdkSessionMetadata(target, metadata);
}

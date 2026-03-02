/**
 * Soul Dashboard - Session Providers
 *
 * 세션 데이터 소스에 따른 Provider 구현체를 내보냅니다.
 */

// Types
export type {
  StorageMode,
  SessionListProvider,
  SessionDetailProvider,
  SessionStorageProvider,
  SoulBlockType,
  SerendipityBlock,
  PortableTextContent,
  PortableTextBlock,
  PortableTextSpan,
  PortableTextMarkDef,
  SessionKey,
} from "./types";

// File Provider
export {
  FileSessionProvider,
  fileSessionProvider,
} from "./FileSessionProvider";

// Serendipity Provider
export {
  SerendipitySessionProvider,
  serendipitySessionProvider,
  type SerendipitySessionProviderOptions,
} from "./SerendipitySessionProvider";

// === Provider Factory ===

import type { SessionStorageProvider, StorageMode } from "./types";
import { fileSessionProvider } from "./FileSessionProvider";
import { serendipitySessionProvider } from "./SerendipitySessionProvider";

/**
 * 스토리지 모드에 따라 적절한 Provider를 반환합니다.
 */
export function getSessionProvider(mode: StorageMode): SessionStorageProvider {
  switch (mode) {
    case "file":
      return fileSessionProvider;
    case "serendipity":
      return serendipitySessionProvider;
    default:
      throw new Error(`Unknown storage mode: ${mode}`);
  }
}

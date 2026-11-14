import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "pino";

import { renameWithTransientRetry } from "../atomic_file_rename.js";

/** 미결 파일이 놓이는 EVENT_OUTBOX_DIR 아래 하위 폴더 이름이다. */
export const COMPLETION_SETTLEMENT_SUBDIRECTORY = "completion-settlements";
const QUARANTINE_SUBDIRECTORY = "quarantine";

/**
 * 완료 정산 미결 하나다. 종료 사건의 좌표(세션, 종료의 의미 중복 키, 러너 등록과 실행
 * 명령)가 신원이고, 아웃박스에 붙은 뒤의 좌표와 중앙이 적용한 종료 사건 번호는 뒤에 덧붙는다.
 */
export interface CompletionSettlementEntry {
  version: 1;
  sessionId: string;
  /** 종료의 의미 중복 키(`session_terminal:<세션>:...`). 미결의 신원이다. */
  dedupeKey: string;
  registrationId: string | null;
  executionCommandId: string | null;
  createdAt: string;
  /** 아웃박스에 붙은 뒤에만 있다. */
  streamId?: string;
  sourceSeq?: number;
  /** 중앙이 이 종료를 적용했다는 응답을 받은 뒤에만 있다. */
  terminationEventId?: number;
}

export type CompletionSettlementIdentity = Pick<
  CompletionSettlementEntry,
  "sessionId" | "dedupeKey" | "registrationId" | "executionCommandId"
>;

/** 종료를 올리는 정상 길이 쓰는 좌표다. 이 좌표만으로 같은 미결을 다시 가리킨다. */
export interface CompletionSettlementLedger {
  /**
   * 종료를 아웃박스에 붙이기 전에 미결을 영속하고 정상 길이 쥔다. 같은 키가 이미
   * 있으면 아웃박스 좌표와 사건 번호를 비우고 처음부터 다시 시작하고 `replaced`로 알린다
   * (앞 시도의 줄이 이미 아웃박스에 있을 수 있으므로 붙이기 실패가 지워서는 안 된다).
   */
  begin(identity: CompletionSettlementIdentity): Promise<{ replaced: boolean }>;
  /** 붙인 뒤 받은 아웃박스 좌표를 덧붙인다. */
  recordAppended(
    dedupeKey: string,
    appended: { streamId: string; sourceSeq: number },
  ): Promise<void>;
  /** 응답을 받은 뒤 중앙이 적용한 종료 사건 번호를 덧붙인다. */
  recordApplied(dedupeKey: string, terminationEventId: number): Promise<void>;
  /**
   * 아웃박스에 붙이지 못한 종료의 미결을 지운다. 붙이기가 줄을 쓴 뒤에 던졌을 수 있으므로
   * 아웃박스에 그 종료의 줄이 있으면 지우지 않고 쥠을 풀어 훑기에 맡긴다(찾지 못해도 마찬가지).
   * 지웠으면 true다.
   */
  discardUnlessAppended(dedupeKey: string): Promise<boolean>;
  /** 정산을 마쳤으므로 지운다. */
  close(dedupeKey: string): Promise<void>;
  /** 정상 길이 쥔 것을 풀고 미결은 훑기에 맡긴다. */
  release(dedupeKey: string): void;
  /** 그 세션의 미결을 모두 지운다(삭제, 중앙 세션 없음). */
  closeAllForSession(sessionId: string): Promise<void>;
  hasPendingForSession(sessionId: string): Promise<boolean>;
}

/**
 * 미결 하나당 파일 하나를 EVENT_OUTBOX_DIR 아래 전용 하위 폴더에 둔다. 쓰기는 임시 파일에
 * 쓰고 fsync한 뒤 이름을 바꾸므로 읽는 쪽은 옛 내용이나 새 내용만 본다. 깨졌거나 읽을 수 없는
 * 파일은 지우지 않고 격리 폴더로 옮기고 경고를 남긴다.
 */
export class CompletionSettlementStore implements CompletionSettlementLedger {
  private readonly directory: string;
  private readonly quarantineDirectory: string;
  /**
   * 정상 길이 쥐고 있는 키와 그 세션이다. 시간으로 풀지 않는다: 정상 길이 마무리 단계에서
   * 놓는다. 메모리뿐이라 새는 쥠도 프로세스를 넘지 않는다.
   */
  private readonly holds = new Map<string, string>();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    outboxDirectory: string,
    private readonly logger: Pick<Logger, "warn" | "info">,
    private readonly now: () => number = Date.now,
    /** 있으면 붙이기 실패 때 줄이 이미 아웃박스에 있는지 본다. */
    private readonly outbox?: { findBySemanticDedupeKey(key: string): Promise<unknown | null> },
  ) {
    if (!outboxDirectory) throw new Error("EVENT_OUTBOX_DIR required");
    this.directory = join(outboxDirectory, COMPLETION_SETTLEMENT_SUBDIRECTORY);
    this.quarantineDirectory = join(this.directory, QUARANTINE_SUBDIRECTORY);
  }

  async begin(identity: CompletionSettlementIdentity): Promise<{ replaced: boolean }> {
    return await this.exclusive(async () => {
      await mkdir(this.directory, { recursive: true });
      const replaced = (await this.read(this.pathOf(identity.dedupeKey))) !== null;
      this.holds.set(identity.dedupeKey, identity.sessionId);
      try {
        await this.write({
          version: 1,
          sessionId: identity.sessionId,
          dedupeKey: identity.dedupeKey,
          registrationId: identity.registrationId,
          executionCommandId: identity.executionCommandId,
          createdAt: new Date(this.now()).toISOString(),
        });
      } catch (error) {
        // 쓰지 못한 미결은 쥘 것이 없다. 던져서 종료를 올리지 않는다.
        this.holds.delete(identity.dedupeKey);
        throw error;
      }
      return { replaced };
    });
  }

  async recordAppended(
    dedupeKey: string,
    appended: { streamId: string; sourceSeq: number },
  ): Promise<void> {
    await this.update(dedupeKey, (entry) => ({
      ...entry,
      streamId: appended.streamId,
      sourceSeq: appended.sourceSeq,
    }));
  }

  async recordApplied(dedupeKey: string, terminationEventId: number): Promise<void> {
    await this.update(dedupeKey, (entry) => ({ ...entry, terminationEventId }));
  }

  async discardUnlessAppended(dedupeKey: string): Promise<boolean> {
    if (this.outbox) {
      try {
        if ((await this.outbox.findBySemanticDedupeKey(dedupeKey)) !== null) {
          this.release(dedupeKey);
          return false;
        }
      } catch (err) {
        // 줄이 있는지 모르면 지우지 않는다. 미결을 남기는 쪽이 안전하다(훑기가 중앙을 보고 가른다).
        this.logger.warn(
          { err },
          "completion settlement could not check the outbox for an unappended terminal; it stays pending",
        );
        this.release(dedupeKey);
        return false;
      }
    }
    await this.close(dedupeKey);
    return true;
  }

  async close(dedupeKey: string): Promise<void> {
    await this.exclusive(async () => {
      this.holds.delete(dedupeKey);
      await this.remove(dedupeKey);
    });
  }

  release(dedupeKey: string): void {
    this.holds.delete(dedupeKey);
  }

  /** 훑기가 쓴다. 정상 길이 그사이 다시 쥐었으면 지우지 않는다. */
  async closeUnlessHeld(dedupeKey: string): Promise<boolean> {
    return await this.exclusive(async () => {
      if (this.holds.has(dedupeKey)) return false;
      await this.remove(dedupeKey);
      return true;
    });
  }

  async closeAllForSession(sessionId: string): Promise<void> {
    await this.exclusive(async () => {
      for (const entry of await this.readAll()) {
        if (entry.sessionId !== sessionId) continue;
        this.holds.delete(entry.dedupeKey);
        await this.remove(entry.dedupeKey);
      }
    });
  }

  async hasPendingForSession(sessionId: string): Promise<boolean> {
    return await this.exclusive(async () =>
      (await this.readAll()).some((entry) => entry.sessionId === sessionId));
  }

  /**
   * 정상 길이 쥔 세션의 미결은 건너뛰고 나머지를 읽는다. 같은 세션에 쥔 미결이 하나라도 있으면
   * 그 세션의 미결을 모두 건너뛴다: 쥔 종료의 정상 길이 그 세션의 보고를 맡고 있다.
   */
  async listUnheld(): Promise<CompletionSettlementEntry[]> {
    return await this.exclusive(async () =>
      (await this.readAll()).filter((entry) =>
        !this.holds.has(entry.dedupeKey) && !this.isSessionHeld(entry.sessionId)));
  }

  /** 그 세션에서 정상 길이 쥔 미결이 있는지 본다. */
  isSessionHeld(sessionId: string): boolean {
    for (const held of this.holds.values()) {
      if (held === sessionId) return true;
    }
    return false;
  }

  async list(): Promise<CompletionSettlementEntry[]> {
    return await this.exclusive(async () => await this.readAll());
  }

  private pathOf(dedupeKey: string): string {
    const name = createHash("sha256").update(dedupeKey).digest("hex").slice(0, 40);
    return join(this.directory, `${name}.json`);
  }

  private async update(
    dedupeKey: string,
    change: (entry: CompletionSettlementEntry) => CompletionSettlementEntry,
  ): Promise<void> {
    await this.exclusive(async () => {
      const entry = await this.read(this.pathOf(dedupeKey));
      // 이미 지워졌으면 덧붙일 것이 없다(훑기가 닫았거나 삭제가 지웠다).
      if (!entry) return;
      await this.write(change(entry));
    });
  }

  private async write(entry: CompletionSettlementEntry): Promise<void> {
    const path = this.pathOf(entry.dedupeKey);
    const temporaryPath = `${path}.tmp`;
    const handle = await open(temporaryPath, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithTransientRetry(temporaryPath, path);
    await this.syncDirectory();
  }

  /** 이름 바꾸기와 지우기가 디스크에 남도록 폴더도 동기화한다. 지원하지 않는 곳은 건너뛴다. */
  private async syncDirectory(): Promise<void> {
    try {
      const handle = await open(this.directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // 폴더를 열 수 없는 플랫폼(Windows)은 이름 바꾸기만으로 둔다.
    }
  }

  private async remove(dedupeKey: string): Promise<void> {
    try {
      await unlink(this.pathOf(dedupeKey));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      return;
    }
    await this.syncDirectory();
  }

  private async readAll(): Promise<CompletionSettlementEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const entries: CompletionSettlementEntry[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const entry = await this.read(join(this.directory, name));
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /** 없으면 null이다. 깨졌거나 읽을 수 없으면 지우지 않고 격리하고 null이다. */
  private async read(path: string): Promise<CompletionSettlementEntry | null> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      await this.quarantine(path, error);
      return null;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isEntry(parsed)) throw new Error("completion settlement entry is invalid");
      return parsed;
    } catch (error) {
      await this.quarantine(path, error);
      return null;
    }
  }

  private async quarantine(path: string, cause: unknown): Promise<void> {
    const name = path.slice(this.directory.length + 1);
    try {
      await mkdir(this.quarantineDirectory, { recursive: true });
      const target = join(this.quarantineDirectory, `${name}.${this.now()}.corrupt`);
      await rename(path, target);
      this.logger.warn(
        { err: cause, path, quarantined: target },
        "completion settlement file was unreadable and moved to quarantine",
      );
    } catch (error) {
      this.logger.warn(
        { err: error, path, unreadableReason: cause instanceof Error ? cause.message : String(cause) },
        "completion settlement file was unreadable and could not be quarantined",
      );
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return await result;
  }
}

function isEntry(value: unknown): value is CompletionSettlementEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return entry.version === 1
    && typeof entry.sessionId === "string"
    && typeof entry.dedupeKey === "string"
    && (entry.registrationId === null || typeof entry.registrationId === "string")
    && (entry.executionCommandId === null || typeof entry.executionCommandId === "string")
    && typeof entry.createdAt === "string"
    && (entry.streamId === undefined || typeof entry.streamId === "string")
    && (entry.sourceSeq === undefined || Number.isSafeInteger(entry.sourceSeq))
    && (entry.terminationEventId === undefined
      || Number.isSafeInteger(entry.terminationEventId));
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

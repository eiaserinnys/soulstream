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

/**
 * 정상 길 하나가 쥔 표다. begin마다 새로 나오고 객체 자체가 신원이다. 같은 종료 키를 두 길이
 * 함께 쥘 수 있다(사람의 멈춤과 실행 마무리가 같은 종료를 함께 올린다). 같은 표를 두 번 놓아도
 * 한 번만 센다.
 */
export interface CompletionSettlementHold {
  readonly dedupeKey: string;
  readonly sessionId: string;
}

/** 종료를 올리는 정상 길이 쓰는 좌표다. */
export interface CompletionSettlementLedger {
  /**
   * 종료를 아웃박스에 붙이기 전에 미결을 영속하고 정상 길이 쥔다. 같은 키가 이미 있으면
   * `replaced`로 알린다(앞 시도나 함께 쥔 길의 줄이 이미 아웃박스에 있을 수 있으므로 붙이기
   * 실패가 지워서는 안 된다). 다른 길이 쥐고 있으면 그 기록을 그대로 쓰고 쥠만 나눈다. 아무도
   * 쥐지 않은 옛 기록이면 아웃박스 좌표와 사건 번호를 비우고 처음부터 다시 쓴다.
   */
  begin(identity: CompletionSettlementIdentity): Promise<{
    replaced: boolean;
    hold: CompletionSettlementHold;
  }>;
  /** 붙인 뒤 받은 아웃박스 좌표를 덧붙인다. */
  recordAppended(
    dedupeKey: string,
    appended: { streamId: string; sourceSeq: number },
  ): Promise<void>;
  /** 응답을 받은 뒤 중앙이 적용한 종료 사건 번호를 덧붙인다. */
  recordApplied(dedupeKey: string, terminationEventId: number): Promise<void>;
  /**
   * 아웃박스에 붙이지 못한 종료의 미결을 지운다. 같은 키를 다른 길이 아직 쥐고 있으면 그 길이
   * 붙일 수 있으므로 지우지 않고 이 표만 놓는다. 붙이기가 줄을 쓴 뒤에 던졌을 수 있으므로
   * 아웃박스에 그 종료의 줄이 있으면 지우지 않고 쥠을 풀어 훑기에 맡긴다(찾지 못해도 마찬가지).
   * 지웠으면 true다.
   */
  discardUnlessAppended(hold: CompletionSettlementHold): Promise<boolean>;
  /**
   * 이 길이 정산을 마쳤다. 표를 놓고, 같은 키를 쥔 다른 길이 없으면 미결을 지운다. 다른 길이
   * 남아 있으면 미결은 그 길이 닫거나, 놓은 뒤 훑기가 「이미 등록됨」으로 닫는다.
   */
  settle(hold: CompletionSettlementHold): Promise<void>;
  /** 이 길의 표를 놓고 미결은 훑기에 맡긴다. */
  release(hold: CompletionSettlementHold): void;
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
   * 종료 키마다 정상 길이 쥔 표들이다. 마지막 표가 놓일 때만 그 키의 쥠이 풀린다. 시간으로 풀지
   * 않는다: 정상 길이 마무리 단계에서 놓는다. 메모리뿐이라 새는 쥠도 프로세스를 넘지 않는다.
   */
  private readonly holds = new Map<string, Set<CompletionSettlementHold>>();
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

  async begin(identity: CompletionSettlementIdentity): Promise<{
    replaced: boolean;
    hold: CompletionSettlementHold;
  }> {
    return await this.exclusive(async () => {
      await mkdir(this.directory, { recursive: true });
      const replaced = (await this.read(this.pathOf(identity.dedupeKey))) !== null;
      const hold: CompletionSettlementHold = {
        dedupeKey: identity.dedupeKey,
        sessionId: identity.sessionId,
      };
      const holders = this.holds.get(identity.dedupeKey);
      // 다른 길이 같은 종료를 쥐고 올리는 중이다. 그 길이 덧붙인 좌표를 지우지 않고 쥠만 나눈다.
      if (replaced && holders !== undefined) {
        holders.add(hold);
        return { replaced, hold };
      }
      // 쓰지 못하면 던져서 종료를 올리지 않는다. 쥘 것이 없으므로 표도 남기지 않는다.
      await this.write({
        version: 1,
        sessionId: identity.sessionId,
        dedupeKey: identity.dedupeKey,
        registrationId: identity.registrationId,
        executionCommandId: identity.executionCommandId,
        createdAt: new Date(this.now()).toISOString(),
      });
      if (holders === undefined) this.holds.set(identity.dedupeKey, new Set([hold]));
      else holders.add(hold);
      return { replaced, hold };
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

  async discardUnlessAppended(hold: CompletionSettlementHold): Promise<boolean> {
    if (this.heldByOthers(hold)) {
      // 함께 쥔 길이 아직 붙이는 중일 수 있다. 그 길의 미결을 지우지 않는다.
      this.release(hold);
      return false;
    }
    if (this.outbox) {
      try {
        if ((await this.outbox.findBySemanticDedupeKey(hold.dedupeKey)) !== null) {
          this.release(hold);
          return false;
        }
      } catch (err) {
        // 줄이 있는지 모르면 지우지 않는다. 미결을 남기는 쪽이 안전하다(훑기가 중앙을 보고 가른다).
        this.logger.warn(
          { err },
          "completion settlement could not check the outbox for an unappended terminal; it stays pending",
        );
        this.release(hold);
        return false;
      }
    }
    return await this.settleHold(hold);
  }

  async settle(hold: CompletionSettlementHold): Promise<void> {
    await this.settleHold(hold);
  }

  /** 표를 놓고, 같은 키를 쥔 길이 더 없으면 미결을 지운다. 지웠으면 true다. */
  private async settleHold(hold: CompletionSettlementHold): Promise<boolean> {
    return await this.exclusive(async () => {
      this.release(hold);
      if (this.holds.has(hold.dedupeKey)) return false;
      await this.remove(hold.dedupeKey);
      return true;
    });
  }

  /**
   * 쥔 길과 무관하게 그 종료의 미결을 지운다. 종료가 영구 거절되는 등 그 종료로는 보고할 것이
   * 없을 때 쓴다. 함께 쥔 길의 표는 무효가 된다(놓아도 아무 일이 없다).
   */
  async close(dedupeKey: string): Promise<void> {
    await this.exclusive(async () => {
      this.holds.delete(dedupeKey);
      await this.remove(dedupeKey);
    });
  }

  release(hold: CompletionSettlementHold): void {
    const holders = this.holds.get(hold.dedupeKey);
    if (!holders?.delete(hold)) return;
    if (holders.size === 0) this.holds.delete(hold.dedupeKey);
  }

  private heldByOthers(hold: CompletionSettlementHold): boolean {
    const holders = this.holds.get(hold.dedupeKey);
    if (holders === undefined) return false;
    return holders.size > (holders.has(hold) ? 1 : 0);
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
    for (const holders of this.holds.values()) {
      for (const hold of holders) {
        if (hold.sessionId === sessionId) return true;
      }
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

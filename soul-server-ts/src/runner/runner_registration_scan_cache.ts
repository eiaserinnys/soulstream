import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { RunnerRegistration } from "./runner_process_registry.js";
import { isProcessAlive } from "./runner_process_lock.js";
import { runnerHostStatePath } from "./runner_host_state_store.js";

const FULL_RECHECK_INTERVAL_MS = 300_000;
/**
 * 전체 재확인 만료를 여러 스캔에 나누는 지터의 한 칸. 기본 스캔 주기(15초)와 같게 두어
 * 한 칸이 한 스캔이 되게 한다. 스무 칸이 전체 재확인 간격을 덮으므로 어떤 항목도 지금
 * 간격의 두 배를 넘겨 재확인 없이 남지 않는다(카드 #1476: 재기동 뒤 같은 때 기록된 항목이
 * 한 스캔에서 모두 만료되어 runner.sqlite를 수백 번 다시 열던 문제).
 */
const RECHECK_JITTER_SLOT_MS = 15_000;
const RECHECK_JITTER_SLOTS = FULL_RECHECK_INTERVAL_MS / RECHECK_JITTER_SLOT_MS;

export interface RunnerRegistrationCacheMissCounts {
  /** 《캐시 못 함》: 살아 있는 러너처럼 canCache가 거짓이거나, 읽는 동안 지문이 바뀐 항목. */
  uncacheable: number;
  /** 캐시 항목이 있었지만 지문이 바뀐 항목. */
  fingerprintChanged: number;
  /** 지문은 같고 전체 재확인 간격(지터 포함)이 지난 항목. */
  fullRecheckExpired: number;
  /** 캐시에 없던 항목. */
  notCached: number;
}

type Entry = {
  fingerprint: string;
  registration: RunnerRegistration;
  checkedAt: number;
  /** 같은 스캔에서 함께 기록된 항목의 만료를 흩뜨리는 지터. */
  jitterMs: number;
};

export type RunnerRegistrationSnapshotEntry = Pick<Entry, "fingerprint" | "registration"> & {
  directory: string;
};

/** Memory owned by a periodic scanner, never by destructive readers. */
export class RunnerRegistrationScanCache {
  private readonly entries = new Map<string, Entry>();
  private readonly misses: RunnerRegistrationCacheMissCounts = {
    uncacheable: 0,
    fingerprintChanged: 0,
    fullRecheckExpired: 0,
    notCached: 0,
  };
  constructor(private readonly now: () => number = Date.now) {}

  snapshot(): RunnerRegistrationSnapshotEntry[] {
    return [...this.entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([directory, { fingerprint, registration }]) => ({
        directory, fingerprint, registration: structuredClone(registration),
      }));
  }

  restore(entries: RunnerRegistrationSnapshotEntry[]): void {
    this.entries.clear();
    const checkedAt = this.now();
    for (const [position, entry] of entries.entries()) {
      this.entries.set(entry.directory, {
        fingerprint: entry.fingerprint,
        registration: structuredClone(entry.registration),
        checkedAt,
        jitterMs: recheckJitterMs(position),
      });
    }
  }

  /**
   * scanPosition은 한 스캔 안에서 이 폴더를 읽는 순번이다. 같은 때 기록된 항목들이 한
   * 스캔에서 모두 만료되지 않도록 항목마다 다른 지터를 붙인다. 스캔 밖에서 부르면 0이라
   * 지터가 없고, 간격은 전체 재확인 간격 그대로다.
   */
  async read(
    directory: string,
    readFresh: () => Promise<RunnerRegistration>,
    scanPosition = 0,
  ): Promise<RunnerRegistration> {
    const before = await fingerprint(directory);
    const cached = this.entries.get(directory);
    const now = this.now();
    let missReason: keyof RunnerRegistrationCacheMissCounts;
    if (cached === undefined) {
      missReason = "notCached";
    } else if (cached.fingerprint !== before) {
      missReason = "fingerprintChanged";
    } else if (now - cached.checkedAt >= FULL_RECHECK_INTERVAL_MS + cached.jitterMs) {
      missReason = "fullRecheckExpired";
    } else if (cached.registration.pid !== null && isProcessAlive(cached.registration.pid)) {
      missReason = "uncacheable";
    } else {
      // Callers may annotate the recovered registration; keep the stored proof isolated.
      return structuredClone(cached.registration);
    }
    this.entries.delete(directory);
    const registration = await readFresh();
    if (canCache(registration) && before === await fingerprint(directory)) {
      this.entries.set(directory, {
        fingerprint: before,
        registration: structuredClone(registration),
        checkedAt: this.now(),
        jitterMs: recheckJitterMs(scanPosition),
      });
    } else {
      missReason = "uncacheable";
    }
    this.misses[missReason] += 1;
    return registration;
  }

  /** 마지막 reset 뒤 등록 캐시를 쓰지 못한 까닭별 건수. */
  missCounts(): RunnerRegistrationCacheMissCounts {
    return { ...this.misses };
  }

  resetMissCounts(): void {
    this.misses.uncacheable = 0;
    this.misses.fingerprintChanged = 0;
    this.misses.fullRecheckExpired = 0;
    this.misses.notCached = 0;
  }

  prune(directories: Set<string>): void {
    for (const directory of this.entries.keys()) {
      if (!directories.has(directory)) this.entries.delete(directory);
    }
  }
}

function recheckJitterMs(scanPosition: number): number {
  const slot = Math.trunc(scanPosition) % RECHECK_JITTER_SLOTS;
  return slot * RECHECK_JITTER_SLOT_MS;
}

export function canCache(registration: RunnerRegistration): boolean {
  if (registration.pidAlive) return false;
  if (registration.retiredAt) return true;
  const state = registration.lifecycle?.execution_state;
  return state === "reaped" || (state === "closed"
    && (registration.closedTailState?.status === "fully_acknowledged"
      || registration.closedTailState?.status === "empty_prebootstrap"));
}

async function fingerprint(directory: string): Promise<string> {
  const database = join(directory, "runner.sqlite");
  const host = runnerHostStatePath(database);
  const paths = [
    join(directory, "runner-config.json"), join(directory, "runner-identity.json"),
    join(directory, "runner.pid"), join(directory, "runner.lock"),
    join(directory, "runner-lifecycle.json"),
    database, `${database}-wal`, host, `${host}-wal`,
  ];
  return JSON.stringify(await Promise.all(paths.map(async (path) => {
    try {
      const file = await stat(path, { bigint: true });
      return [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].map(String);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  })));
}

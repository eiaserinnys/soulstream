import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { createApiClient, type ApiClient } from '../api/client';
import { ApiHttpError } from '../api/clientCore';
import {
  UI_EVENT_SCHEMA_VERSION,
  type UiEventEntry,
  type UiEventTarget,
  type UiEventsBatch,
  type UiEventsConfig,
  type UiEventsPostResult,
  type UiEventWire,
} from '../api/uiEventsEndpoints';
import { isAuthScopeCurrent, type AuthScopeSnapshot } from './auth-scope';
export { UI_EVENT_SCHEMA_VERSION } from '../api/uiEventsEndpoints';
export type { UiEventEntry, UiEventTarget } from '../api/uiEventsEndpoints';
const INSTALL_ID_KEY = 'soul-app.ui-events.install-id.v1';
const PENDING_QUEUE_KEY = 'soul-app.ui-events.pending.v1';
const DEFAULT_CONFIG = {
  flushIntervalMs: 10_000,
  maxBatchSize: 20,
  maxQueueSize: 500,
} as const;

type CollectionScope = Pick<AuthScopeSnapshot, 'serverUrl' | 'jwt' | 'generation'>;
type UiUsageClient = Pick<ApiClient, 'getUiEventsConfig' | 'postUiEvents'>;
type CommonEvent = { target?: UiEventTarget | null; from?: UiEventTarget | null; entry?: UiEventEntry | null };

type FlowEvent = CommonEvent & { flowId: string };

/** 공통 규약 §4 allowlist를 앱 발행 지점에서 그대로 표현한다. */
export type UiUsageEventInput =
  | (CommonEvent & { type: 'view_open' })
  | (FlowEvent & {
    type: 'search_submit';
    attrs: {
      queryText: string;
      trigger: 'typing' | 'filter' | 'submit';
      searchSessionId?: string;
      scope?: string;
    };
  })
  | (FlowEvent & {
    type: 'search_result';
    attrs: {
      status: 'ok' | 'error' | 'aborted';
      durationMs: number;
      resultCount?: number;
      errorCode?: string;
    };
  })
  | (FlowEvent & {
    type: 'search_result_open';
    attrs: { rank: number; resultKind?: string };
  })
  | (CommonEvent & {
    type: 'notification_open';
    attrs: {
      surface: 'browser_notification' | 'push' | 'feed_card' | 'my_turn';
      navigated?: boolean;
    };
  })
  | (FlowEvent & { type: 'compose_start'; attrs?: { mode?: string } })
  | (FlowEvent & {
    type: 'compose_submit';
    attrs: { draftLength: number; mode: string };
  })
  | (FlowEvent & {
    type: 'compose_result';
    attrs: {
      status: 'ok' | 'error' | 'aborted';
      durationMs: number;
      errorCode?: string;
      sessionEventId?: string | number;
    };
  })
  | (FlowEvent & {
    type: 'compose_abandon';
    attrs: { draftPresent: boolean; draftLength: number; reason?: string };
  })
  | (FlowEvent & {
    type: 'compose_resume';
    attrs: { draftPresent: boolean; draftLength: number };
  })
  | (CommonEvent & { type: 'app_active'; attrs?: { reason?: string } })
  | (CommonEvent & {
    type: 'app_inactive';
    attrs?: { reason?: 'hidden' | 'pagehide' | 'background' };
  })
  | (FlowEvent & { type: 'action_start'; attrs: { action: string } })
  | (FlowEvent & {
    type: 'action_end';
    attrs: {
      action: string;
      status: 'ok' | 'error' | 'aborted';
      durationMs: number;
      errorCode?: string;
    };
  });

interface StoredUiEvent {
  installId: string;
  clientSessionKey: string;
  appVersion: string;
  event: UiEventWire;
}

interface PersistedQueue {
  origin: string;
  userEmail: string;
  events: StoredUiEvent[];
}

interface StoragePort {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface UiUsageEventsOptions {
  storage?: StoragePort;
  createClient?: (scope: CollectionScope) => UiUsageClient;
  isScopeCurrent?: (scope: CollectionScope) => boolean;
  createUuid?: () => string;
  now?: () => Date;
  autoFlush?: boolean;
}

interface ActiveConfig {
  flushIntervalMs: number;
  maxBatchSize: number;
  maxQueueSize: number;
}

/**
 * soul-app 전용 UI 사용 로그 수집기.
 *
 * UI의 어느 동작도 이 객체의 네트워크·저장 실패를 기다리거나 전파받지 않는다.
 */
export class UiUsageEvents {
  private readonly storage: StoragePort;
  private readonly createClient: (scope: CollectionScope) => UiUsageClient;
  private readonly scopeIsCurrent: (scope: CollectionScope) => boolean;
  private readonly createUuid: () => string;
  private readonly now: () => Date;
  private readonly autoFlush: boolean;
  private activeScope: CollectionScope | null = null;
  private userEmail: string | null = null;
  private installId: string | null = null;
  private clientSessionKey: string | null = null;
  private appVersion = appVersion();
  private sequence = 0;
  private config: ActiveConfig | null = null;
  private queue: StoredUiEvent[] = [];
  private flushing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private persisted = false;
  private lifecycle = 0;

  constructor(options: UiUsageEventsOptions = {}) {
    this.storage = options.storage ?? AsyncStorage;
    this.createClient = options.createClient ?? ((scope) =>
      createApiClient(scope.serverUrl, { authScope: scope })
    );
    this.scopeIsCurrent = options.isScopeCurrent ?? isAuthScopeCurrent;
    this.createUuid = options.createUuid ?? uuid;
    this.now = options.now ?? (() => new Date());
    this.autoFlush = options.autoFlush ?? true;
  }

  async start(scope: CollectionScope, userEmail: string): Promise<boolean> {
    const lifecycle = ++this.lifecycle;
    this.stopTimer();
    this.activeScope = scope;
    this.userEmail = userEmail;
    this.config = null;
    this.queue = [];
    this.persisted = false;
    this.sequence = 0;

    try {
      this.installId = await this.readOrCreateInstallId();
      if (!this.isActive(lifecycle, scope)) return false;
      this.clientSessionKey = this.createUuid();
      this.appVersion = appVersion();
      await this.hydratePendingQueue(lifecycle, scope, userEmail);
      if (!this.isActive(lifecycle, scope)) return false;
      return this.refreshConfig(lifecycle);
    } catch (error) {
      this.report('start skipped', error);
      return false;
    }
  }

  stop(): void {
    this.lifecycle += 1;
    this.stopTimer();
    this.activeScope = null;
    this.userEmail = null;
    this.config = null;
    this.queue = [];
    this.persisted = false;
    // 로그아웃·서버 전환 뒤에는 어떤 과거 이벤트도 전송하면 안 된다.
    void this.storage.removeItem(PENDING_QUEUE_KEY).catch((error) =>
      this.report('pending queue removal skipped', error),
    );
  }

  async onAppActive(): Promise<boolean> {
    if (!this.activeScope) return false;
    const enabled = await this.refreshConfig(this.lifecycle);
    if (!enabled) return false;
    const recorded = this.record({ type: 'app_active', attrs: { reason: 'foreground' } });
    void this.flush();
    return recorded;
  }

  async onAppInactive(): Promise<void> {
    if (!this.config) return;
    this.record({ type: 'app_inactive', attrs: { reason: 'background' } });
    await this.persistPendingQueue();
    void this.flush();
  }

  record(input: UiUsageEventInput): boolean {
    if (!this.config || !this.activeScope || !this.installId || !this.clientSessionKey) return false;
    try {
      const event: UiEventWire = {
        eventId: this.createUuid(),
        seq: ++this.sequence,
        occurredAt: this.now().toISOString(),
        type: input.type,
        target: input.target ?? null,
        from: input.from ?? null,
        entry: input.entry ?? null,
        flowId: 'flowId' in input ? input.flowId : null,
        attrs: 'attrs' in input ? { ...input.attrs } : {},
      };
      this.queue.push({
        installId: this.installId,
        clientSessionKey: this.clientSessionKey,
        appVersion: this.appVersion,
        event,
      });
      if (this.queue.length > this.config.maxQueueSize) {
        this.queue.splice(0, this.queue.length - this.config.maxQueueSize);
      }
      if (this.autoFlush && this.queue.length >= this.config.maxBatchSize) {
        void this.flush();
      }
      return true;
    } catch (error) {
      this.report('event dropped', error);
      return false;
    }
  }

  async flush(): Promise<void> {
    const scope = this.activeScope;
    const config = this.config;
    if (!scope || !config || this.flushing || this.queue.length === 0) return;
    if (!this.scopeIsCurrent(scope)) return;
    const batchEntries = batchFor(this.queue, config.maxBatchSize);
    if (batchEntries.length === 0) return;
    const batch: UiEventsBatch = {
      schemaVersion: UI_EVENT_SCHEMA_VERSION,
      installId: batchEntries[0].installId,
      clientSessionKey: batchEntries[0].clientSessionKey,
      appVersion: batchEntries[0].appVersion,
      events: batchEntries.map((entry) => entry.event),
    };
    const sentIds = new Set(batch.events.map((event) => event.eventId));
    this.flushing = true;
    try {
      const result = await this.createClient(scope).postUiEvents(batch);
      if (!this.isCurrentScope(scope)) return;
      if (result.disabled === true) {
        // 설정이 전송 사이에 꺼졌다면 200이어도 즉시 fail-closed로 전환한다.
        this.config = null;
        this.stopTimer();
        this.queue = [];
        await this.clearPersistedQueue();
        return;
      }
      this.removeEvents(sentIds);
      if (this.persisted) await this.persistPendingQueue();
    } catch (error) {
      if (!this.isCurrentScope(scope)) return;
      if (error instanceof ApiHttpError && (error.status === 413 || error.status === 422)) {
        this.removeEvents(sentIds);
        if (this.persisted) await this.persistPendingQueue();
        this.report(`permanent batch rejection ${error.status}`, error);
        return;
      }
      await this.persistPendingQueue();
      this.report('flush skipped', error);
    } finally {
      this.flushing = false;
    }
  }

  pendingCount(): number {
    return this.queue.length;
  }

  private async refreshConfig(lifecycle: number): Promise<boolean> {
    const scope = this.activeScope;
    if (!scope || !this.userEmail || !this.installId) return false;
    try {
      const payload = await this.createClient(scope).getUiEventsConfig();
      if (!this.isActive(lifecycle, scope)) return false;
      const config = normalizeConfig(payload);
      if (!config) {
        this.config = null;
        this.stopTimer();
        this.queue = [];
        await this.clearPersistedQueue();
        return false;
      }
      this.config = config;
      if (this.queue.length > config.maxQueueSize) {
        this.queue.splice(0, this.queue.length - config.maxQueueSize);
        if (this.persisted) await this.persistPendingQueue();
      }
      this.startTimer();
      return true;
    } catch (error) {
      if (this.isActive(lifecycle, scope)) {
        this.config = null;
        this.stopTimer();
      }
      this.report('config unavailable', error);
      return false;
    }
  }

  private async readOrCreateInstallId(): Promise<string> {
    const existing = await this.storage.getItem(INSTALL_ID_KEY);
    if (existing) return existing;
    const installId = this.createUuid();
    await this.storage.setItem(INSTALL_ID_KEY, installId);
    return installId;
  }

  private async hydratePendingQueue(
    lifecycle: number,
    scope: CollectionScope,
    userEmail: string,
  ): Promise<void> {
    const raw = await this.storage.getItem(PENDING_QUEUE_KEY);
    if (!raw || !this.isActive(lifecycle, scope)) return;
    let saved: PersistedQueue | null = null;
    try {
      saved = JSON.parse(raw) as PersistedQueue;
    } catch {
      await this.clearPersistedQueue();
      return;
    }
    if (
      !saved
      || saved.origin !== normalizeOrigin(scope.serverUrl)
      || saved.userEmail !== userEmail
      || !Array.isArray(saved.events)
    ) {
      await this.clearPersistedQueue();
      return;
    }
    this.queue = saved.events.filter(isStoredUiEvent);
    this.persisted = true;
  }

  private async persistPendingQueue(): Promise<void> {
    const scope = this.activeScope;
    if (!scope || !this.userEmail || !this.isCurrentScope(scope)) return;
    try {
      if (this.queue.length === 0) {
        await this.clearPersistedQueue();
        return;
      }
      const value: PersistedQueue = {
        origin: normalizeOrigin(scope.serverUrl),
        userEmail: this.userEmail,
        events: this.queue,
      };
      await this.storage.setItem(PENDING_QUEUE_KEY, JSON.stringify(value));
      this.persisted = true;
    } catch (error) {
      this.report('pending queue persistence skipped', error);
    }
  }

  private async clearPersistedQueue(): Promise<void> {
    this.persisted = false;
    try {
      await this.storage.removeItem(PENDING_QUEUE_KEY);
    } catch (error) {
      this.report('pending queue removal skipped', error);
    }
  }

  private removeEvents(eventIds: Set<string>): void {
    this.queue = this.queue.filter(({ event }) => !eventIds.has(event.eventId));
  }

  private startTimer(): void {
    this.stopTimer();
    if (!this.config) return;
    this.timer = setInterval(() => { void this.flush(); }, this.config.flushIntervalMs);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private isActive(lifecycle: number, scope: CollectionScope): boolean {
    return lifecycle === this.lifecycle && this.isCurrentScope(scope);
  }

  private isCurrentScope(scope: CollectionScope): boolean {
    return this.activeScope?.generation === scope.generation
      && this.activeScope.serverUrl === scope.serverUrl
      && this.scopeIsCurrent(scope);
  }

  private report(message: string, error: unknown): void {
    console.warn(`[ui-events] ${message}`, error);
  }
}

export const uiUsageEvents = new UiUsageEvents();

export function createUiUsageFlowId(): string | null {
  try {
    return uuid();
  } catch (error) {
    console.warn('[ui-events] flow id skipped', error);
    return null;
  }
}

export function recordUiUsageEvent(input: UiUsageEventInput): boolean {
  return uiUsageEvents.record(input);
}

function normalizeConfig(payload: UiEventsConfig): ActiveConfig | null {
  if (payload.enabled !== true || payload.schemaVersion !== UI_EVENT_SCHEMA_VERSION) {
    return null;
  }
  return {
    flushIntervalMs: positiveInteger(payload.flushIntervalMs, DEFAULT_CONFIG.flushIntervalMs),
    maxBatchSize: Math.min(50, positiveInteger(payload.maxBatchSize, DEFAULT_CONFIG.maxBatchSize)),
    maxQueueSize: positiveInteger(payload.maxQueueSize, DEFAULT_CONFIG.maxQueueSize),
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

function batchFor(queue: StoredUiEvent[], maxBatchSize: number): StoredUiEvent[] {
  const first = queue[0];
  if (!first) return [];
  return queue.filter((entry) => (
    entry.installId === first.installId
    && entry.clientSessionKey === first.clientSessionKey
    && entry.appVersion === first.appVersion
  )).slice(0, maxBatchSize);
}

function isStoredUiEvent(value: unknown): value is StoredUiEvent {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<StoredUiEvent>;
  return typeof entry.installId === 'string'
    && typeof entry.clientSessionKey === 'string'
    && typeof entry.appVersion === 'string'
    && Boolean(entry.event && typeof entry.event.eventId === 'string');
}

function normalizeOrigin(serverUrl: string): string {
  return serverUrl.replace(/\/$/, '');
}

function appVersion(): string {
  const version = Constants.nativeAppVersion
    ?? Constants.expoConfig?.version
    ?? 'unknown';
  const build = Constants.nativeBuildVersion;
  return build ? `${version}+${build}` : version;
}

function uuid(): string {
  if (typeof Crypto.randomUUID !== 'function') {
    throw new Error('UUID 생성 기능을 사용할 수 없습니다.');
  }
  return Crypto.randomUUID();
}

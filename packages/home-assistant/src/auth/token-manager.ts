import { miotHost, validateClientId, type MiotRegion } from "../miot/protocol.js";

/** Host must provide Keychain/Keystore or another private credential store. */
export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface MiotCredentialScope { region: MiotRegion; clientId: string; redirectUri: string }
export interface MiotCredentials extends MiotCredentialScope {
  version: 1;
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  issuedAt: number;
  refreshAt: number;
  expiresAt: number;
}

export interface MiotTokenResponse { accessToken: string; refreshToken: string; expiresIn: number }

export function createMiotCredentials(scope: MiotCredentialScope, deviceId: string, token: MiotTokenResponse, now: number): MiotCredentials {
  if (!token.accessToken || !token.refreshToken || !Number.isFinite(token.expiresIn) || token.expiresIn <= 0
    || !Number.isFinite(now + token.expiresIn * 1000)) throw new Error("miot_invalid_token");
  return { ...scope, version: 1, deviceId, accessToken: token.accessToken, refreshToken: token.refreshToken,
    issuedAt: now, refreshAt: now + token.expiresIn * 700, expiresAt: now + token.expiresIn * 1000 };
}

/** Refresh on demand at 70% lifetime; no background polling or credential fallback after failure. */
export class MiotTokenManager {
  private current: MiotCredentials | null | undefined;
  private generation = 0;
  private loading: Promise<void> | null = null;
  private refreshing: { generation: number; promise: Promise<string> } | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly key: string;

  constructor(private readonly options: {
    scope: MiotCredentialScope; store: CredentialStore; now?: () => number;
    refresh: (credentials: Readonly<MiotCredentials>) => Promise<MiotTokenResponse>;
  }) {
    miotHost(options.scope.region); validateClientId(options.scope.clientId);
    this.key = `super-looi.miot.${options.scope.region}.${options.scope.clientId}.${encodeURIComponent(options.scope.redirectUri)}`;
  }

  private now() { return (this.options.now ?? Date.now)(); }
  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.writes.then(task);
    this.writes = next.catch(() => {});
    return next;
  }

  private async load(): Promise<void> {
    if (this.current !== undefined) return;
    if (this.loading) return this.loading;
    const generation = this.generation;
    const promise = (async () => {
      let value: string | null;
      try { value = await this.options.store.get(this.key); } catch { throw new Error("miot_credential_store_failed"); }
      if (generation !== this.generation) throw new Error("miot_session_changed");
      if (!value) { this.current = null; return; }
      try {
        const item = JSON.parse(value) as MiotCredentials;
        const scope = this.options.scope;
        if (!item || item.version !== 1 || item.region !== scope.region || item.clientId !== scope.clientId || item.redirectUri !== scope.redirectUri
          || typeof item.accessToken !== "string" || !item.accessToken || typeof item.refreshToken !== "string" || !item.refreshToken
          || typeof item.deviceId !== "string" || !/^ha\.[a-zA-Z0-9-]+$/.test(item.deviceId)
          || ![item.issuedAt, item.refreshAt, item.expiresAt].every(Number.isFinite)
          || item.issuedAt >= item.refreshAt || item.refreshAt >= item.expiresAt) throw new Error();
        this.current = item;
      } catch { this.current = null; throw new Error("miot_invalid_credentials"); }
    })();
    this.loading = promise;
    try { await promise; } finally { if (this.loading === promise) this.loading = null; }
  }

  async install(credentials: MiotCredentials, isCurrent: () => boolean = () => true): Promise<void> {
    const scope = this.options.scope;
    if (credentials.region !== scope.region || credentials.clientId !== scope.clientId || credentials.redirectUri !== scope.redirectUri) {
      throw new Error("miot_credential_scope_mismatch");
    }
    if (!credentials.accessToken || !credentials.refreshToken || !/^ha\.[a-zA-Z0-9-]+$/.test(credentials.deviceId)
      || credentials.version !== 1 || ![credentials.issuedAt, credentials.refreshAt, credentials.expiresAt].every(Number.isFinite)
      || credentials.issuedAt >= credentials.refreshAt || credentials.refreshAt >= credentials.expiresAt) throw new Error("miot_invalid_credentials");
    if (!isCurrent()) throw new Error("miot_session_changed");
    const generation = ++this.generation;
    await this.persist({ ...credentials }, generation, isCurrent);
    if (generation !== this.generation) throw new Error("miot_session_changed");
  }

  private async persist(credentials: MiotCredentials, generation: number, isCurrent: () => boolean = () => true): Promise<void> {
    const previousCurrent = this.current;
    let previousValue: string | null = null;
    const valid = () => generation === this.generation && isCurrent();
    const restore = async () => {
      try {
        if (previousValue === null) await this.options.store.delete(this.key);
        else await this.options.store.set(this.key, previousValue);
      } catch { this.current = null; throw new Error("miot_credential_store_failed"); }
    };
    await this.enqueue(async () => {
      if (!valid()) throw new Error("miot_session_changed");
      try { previousValue = await this.options.store.get(this.key); }
      catch { throw new Error("miot_credential_store_failed"); }
      if (!valid()) throw new Error("miot_session_changed");
      try { await this.options.store.set(this.key, JSON.stringify(credentials)); }
      catch { throw new Error("miot_credential_store_failed"); }
      if (!valid()) { await restore(); throw new Error("miot_session_changed"); }
      this.current = credentials;
    });
    // A cancel/logout may run in the microtask between the queued write and this continuation.
    if (!valid()) {
      if (generation === this.generation && this.current === credentials) {
        const restoringGeneration = ++this.generation;
        this.current = null;
        await this.enqueue(async () => {
          if (restoringGeneration !== this.generation) return;
          await restore();
          if (restoringGeneration === this.generation) this.current = previousCurrent;
        });
      }
      throw new Error("miot_session_changed");
    }
  }

  async clear(): Promise<void> {
    ++this.generation;
    this.current = null;
    await this.enqueue(async () => {
      try { await this.options.store.delete(this.key); } catch { throw new Error("miot_credential_store_failed"); }
    });
  }

  async getAccessToken(): Promise<string> {
    await this.load();
    const credentials = this.current;
    if (!credentials) throw new Error("miot_auth_required");
    if (this.now() < credentials.refreshAt && this.now() >= credentials.issuedAt) return credentials.accessToken;
    const generation = this.generation;
    if (this.refreshing?.generation === generation) return this.refreshing.promise;
    const promise = (async () => {
      let result: MiotTokenResponse;
      try { result = await this.options.refresh({ ...credentials }); }
      catch { throw new Error("miot_token_refresh_failed"); }
      if (generation !== this.generation) throw new Error("miot_session_changed");
      const next = createMiotCredentials(this.options.scope, credentials.deviceId, result, this.now());
      await this.persist(next, generation);
      if (generation !== this.generation) throw new Error("miot_session_changed");
      return next.accessToken;
    })();
    this.refreshing = { generation, promise };
    try { return await promise; } finally { if (this.refreshing?.promise === promise) this.refreshing = null; }
  }
}

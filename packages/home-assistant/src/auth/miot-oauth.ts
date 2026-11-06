import { MIOT_CLIENT_ID, miotHost, miotJson, record, unwrapMiot, validateClientId, type MiotNetworkOptions, type MiotRegion } from "../miot/protocol.js";
import { createMiotCredentials, MiotTokenManager, type CredentialStore, type MiotCredentialScope, type MiotTokenResponse } from "./token-manager.js";

export interface MiotCryptoProvider { randomUUID(): string; sha1(value: string): Promise<string> }
export interface MiotAuthSession { authorizationUrl: string; deviceId: string; state: string; redirectUri: string; expiresAt: number }
export type MiotCallbackResult = { intercepted: false } | { intercepted: true; code: string } | { intercepted: true; error: string };

const webCrypto: MiotCryptoProvider = {
  randomUUID() {
    if (!globalThis.crypto?.randomUUID) throw new Error("miot_secure_random_unavailable");
    return globalThis.crypto.randomUUID();
  },
  async sha1(value) {
    if (!globalThis.crypto?.subtle) throw new Error("miot_sha1_unavailable");
    // The UUID input is ASCII. Avoid a TextEncoder requirement in native hosts.
    const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0));
    const digest = await globalThis.crypto.subtle.digest("SHA-1", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  },
};

export class MiotOAuthClient {
  readonly tokens: MiotTokenManager;
  private readonly scope: MiotCredentialScope;
  private session: MiotAuthSession | null = null;
  private validatedCode: string | null = null;
  private generation = 0;

  constructor(private readonly options: MiotNetworkOptions & {
    redirectUri: string; store: CredentialStore; region?: MiotRegion; clientId?: string;
    crypto?: MiotCryptoProvider; now?: () => number;
  }) {
    const redirect = new URL(options.redirectUri);
    if (redirect.origin !== "http://homeassistant.local:8123" || !/^\/api\/webhook\/[a-zA-Z0-9_-]+$/.test(redirect.pathname)
      || redirect.username || redirect.password || redirect.search || redirect.hash) throw new Error("miot_invalid_redirect_uri");
    this.scope = { redirectUri: redirect.href, region: options.region ?? "cn", clientId: options.clientId ?? MIOT_CLIENT_ID };
    validateClientId(this.scope.clientId); miotHost(this.scope.region);
    this.tokens = new MiotTokenManager({ scope: this.scope, store: options.store, now: options.now,
      refresh: (credentials) => this.requestToken({ refresh_token: credentials.refreshToken }) });
  }

  private now() { return (this.options.now ?? Date.now)(); }

  async beginAuthSession(): Promise<MiotAuthSession> {
    this.cancelAuthSession();
    const generation = this.generation;
    const crypto = this.options.crypto ?? webCrypto;
    const uuid = crypto.randomUUID();
    if (!/^[a-fA-F0-9-]{36}$/.test(uuid)) throw new Error("miot_invalid_device_uuid");
    const deviceId = `ha.${uuid}`;
    const state = await crypto.sha1(`d=${deviceId}`);
    if (!/^[a-f0-9]{40}$/.test(state)) throw new Error("miot_invalid_auth_state");
    if (generation !== this.generation) throw new Error("miot_session_changed");
    const query = new URLSearchParams({ redirect_uri: this.scope.redirectUri, client_id: this.scope.clientId,
      response_type: "code", device_id: deviceId, state, skip_confirm: "False" });
    this.session = { authorizationUrl: `https://account.xiaomi.com/oauth2/authorize?${query}`,
      deviceId, state, redirectUri: this.scope.redirectUri, expiresAt: this.now() + 600_000 };
    return { ...this.session };
  }

  /** The host must block navigation for every intercepted result, including errors. */
  tryInterceptCallbackUrl(value: string): MiotCallbackResult {
    let url: URL;
    try { url = new URL(value); } catch { return { intercepted: false }; }
    const redirect = new URL(this.scope.redirectUri);
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname || url.username || url.password) return { intercepted: false };
    const fail = (error: string): MiotCallbackResult => { this.cancelAuthSession(); return { intercepted: true, error }; };
    if (!this.session) return { intercepted: true, error: "miot_auth_session_expired" };
    if (this.now() >= this.session.expiresAt) return fail("miot_auth_session_expired");
    if (url.hash || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== this.session.state) return fail("miot_auth_state_mismatch");
    if (url.searchParams.has("error")) return fail("miot_auth_denied");
    const codes = url.searchParams.getAll("code");
    if (codes.length !== 1 || !codes[0].trim() || this.validatedCode) return fail("miot_invalid_auth_code");
    this.validatedCode = codes[0];
    return { intercepted: true, code: codes[0] };
  }

  async completeAuthWithCode(code: string): Promise<void> {
    if (!this.session || this.now() >= this.session.expiresAt || !code || this.validatedCode !== code) throw new Error("miot_invalid_auth_code");
    const session = this.session;
    const generation = this.generation;
    this.session = null; this.validatedCode = null;
    const result = await this.requestToken({ code, device_id: session.deviceId });
    if (generation !== this.generation) throw new Error("miot_session_changed");
    // install's final guard is the credential commit point. A later cancel ends navigation,
    // while an already committed account remains logged in until explicit logout.
    await this.tokens.install(createMiotCredentials(this.scope, session.deviceId, result, this.now()), () => generation === this.generation);
  }

  /** Cancel pending navigation/exchange/storage. Use logout to revoke a committed account. */
  cancelAuthSession(): void { ++this.generation; this.session = null; this.validatedCode = null; }
  async logout(): Promise<void> { this.cancelAuthSession(); await this.tokens.clear(); }

  private async requestToken(data: Record<string, string>): Promise<MiotTokenResponse> {
    // client_id is a JSON integer in Xiaomi's protocol, larger than Number.MAX_SAFE_INTEGER.
    const encoded = `{"client_id":${this.scope.clientId},${JSON.stringify({ redirect_uri: this.scope.redirectUri, ...data }).slice(1)}`;
    const url = `${miotHost(this.scope.region)}/app/v2/ha/oauth/get_token?${new URLSearchParams({ data: encoded })}`;
    const result = unwrapMiot(await miotJson(url, { headers: { "Content-Type": "application/x-www-form-urlencoded" } }, this.options));
    if (!record(result) || typeof result.access_token !== "string" || !result.access_token
      || typeof result.refresh_token !== "string" || !result.refresh_token
      || typeof result.expires_in !== "number" || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Error("miot_invalid_token");
    return { accessToken: result.access_token, refreshToken: result.refresh_token, expiresIn: result.expires_in };
  }
}

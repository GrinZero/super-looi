import { unsupported } from "../bridge.js";
interface NativeOAuthAdapter {
  redirectUrl: string;
  subscribe(listener: (url: string) => void): () => void;
}
let adapter: NativeOAuthAdapter | undefined;
export function installNativeOAuthCallbackAdapter(value: NativeOAuthAdapter) {
  adapter = value;
  return () => {
    if (adapter === value) adapter = undefined;
  };
}
/** Deep-link callback contract for mobile; never opens a local TCP server. */
export class OAuthCallbackServer {
  private pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      path?: string;
    }
  >();
  private unsubscribe: () => void;
  private constructor(
    readonly redirectUrl: string,
    private timeoutMs: number,
    host: NativeOAuthAdapter,
  ) {
    this.unsubscribe = host.subscribe((url) => this.handle(url));
  }
  static async listen(options: { timeoutMs?: number } = {}) {
    if (!adapter)
      unsupported("OAuth callback requires a native deep-link adapter");
    return new OAuthCallbackServer(
      adapter.redirectUrl,
      options.timeoutMs ?? 300000,
      adapter,
    );
  }
  waitForCallback(state: string, path?: string) {
    if (this.pending.has(state))
      throw new Error("OAuth state is already pending");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(state);
        reject(new Error("OAuth callback timed out"));
      }, this.timeoutMs);
      this.pending.set(state, { resolve, reject, timer, path });
    });
  }
  private handle(raw: string) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    const base = new URL(this.redirectUrl);
    if (url.protocol !== base.protocol || url.host !== base.host) return;
    const state = url.searchParams.get("state");
    const pending = state ? this.pending.get(state) : undefined;
    if (!state || !pending) return;
    if (url.pathname !== (pending.path ?? base.pathname)) return;
    clearTimeout(pending.timer);
    this.pending.delete(state);
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error || !code) {
      pending.reject(
        new Error(
          error
            ? (url.searchParams.get("error_description") ?? error)
            : "Missing authorization code",
        ),
      );
      return;
    }
    pending.resolve({
      code,
      state,
      ...(url.searchParams.get("iss")
        ? { iss: url.searchParams.get("iss") }
        : {}),
    });
  }
  async close() {
    this.unsubscribe();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("OAuth callback closed"));
    }
    this.pending.clear();
  }
}

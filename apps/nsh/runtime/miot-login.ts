import type { UserActionRef } from "@super-looi/contracts";
import type { HomeConnection, HomeConfiguration } from "./home.js";

export interface LoginBrowser {
  open(authorization: string, redirect: string): void;
  status(): string;
  takeCallback(): string;
  cancel(): void;
}
interface LoginHost {
  beginMiotLogin(region: HomeConfiguration["region"], action: UserActionRef): Promise<{
    authorizationUrl: string; redirectUri: string; expiresAt: number; attempt: number;
  }>;
  finishMiotLogin(attempt: number, callback: string, isCurrent: () => boolean): Promise<HomeConnection>;
  cancelMiotLogin(): void;
}

/** One explicit UI attempt owns the browser through the credential commit point. */
export class MiotLoginFlow {
  private runId = 0;
  private browser?: LoginBrowser;
  private running = false;
  constructor(private readonly options: {
    runtime: LoginHost;
    browser: () => LoginBrowser;
    active: () => boolean;
    onRunning: (value: boolean) => void;
  }) {}

  async start(region: HomeConfiguration["region"], action: UserActionRef): Promise<HomeConnection> {
    if (this.running) throw new Error("@looi:runtimeXiaomiSigninIsAlreadyRunning");
    if (!this.options.active()) throw new Error("@looi:runtimeReturnToTheAppAndSignInAgain");
    const runId = ++this.runId;
    this.running = true;
    this.options.onRunning(true);
    let browser: LoginBrowser | undefined;
    let committed = false;
    const current = () => runId === this.runId && this.running && this.options.active();
    try {
      const session = await this.options.runtime.beginMiotLogin(region, action);
      if (!current()) throw new Error("@looi:runtimeXiaomiSigninCancelled");
      browser = this.options.browser();
      this.browser = browser;
      browser.open(session.authorizationUrl, session.redirectUri);
      while (current()) {
        if (Date.now() >= session.expiresAt) throw new Error("@looi:runtimeXiaomiSigninExpiredTryAgain");
        const state = browser.status();
        if (state === "callback") {
          const callback = browser.takeCallback();
          if (!callback) throw new Error("@looi:runtimeXiaomiCallbackExpiredTryAgain");
          const ownedBrowser = browser;
          const result = await this.options.runtime.finishMiotLogin(session.attempt, callback, () => {
            try { return current() && ownedBrowser.status() === "consumed"; }
            catch { return false; }
          });
          // Token commit precedes discovery. Later cancellation never logs out the account.
          committed = true;
          if (!current()) throw new Error("@looi:runtimeXiaomiSigninEndedCheckTheConnectionStatus");
          return result;
        }
        if (state !== "loading") throw new Error(state === "cancelled" ? "@looi:runtimeXiaomiSigninCancelled" : "@looi:runtimeXiaomiSigninIncompleteTryAgain");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("@looi:runtimeXiaomiSigninCancelled");
    } finally {
      try { browser?.cancel(); } catch { /* native host may already be disposed */ }
      if (runId === this.runId) {
        if (!committed) this.options.runtime.cancelMiotLogin();
        this.browser = undefined;
        this.running = false;
        this.options.onRunning(false);
      }
    }
  }

  cancel() {
    ++this.runId;
    const wasRunning = this.running;
    this.running = false;
    try { this.browser?.cancel(); } catch { /* teardown still invalidates OAuth */ }
    this.browser = undefined;
    if (wasRunning) this.options.runtime.cancelMiotLogin();
    this.options.onRunning(false);
  }
}
